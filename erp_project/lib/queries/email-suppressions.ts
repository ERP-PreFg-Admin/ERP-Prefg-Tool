// Addresses SES told us not to send to again — see
// prisma/add_email_suppressions.sql for why this is its own table rather than a
// flag on entity_emails.

export const emailSuppressionsSql = {
  /**
   * Every suppressed address, lowercased. Read on each send to filter the
   * recipient list.
   *
   * Deliberately unpaginated and unfiltered: the list is small (one row per
   * address that has ever hard-bounced) and a partial read would silently let a
   * suppressed address through, which is the exact failure this table exists to
   * prevent. Revisit only if it grows past a few thousand rows.
   */
  selectAll: `SELECT email FROM email_suppressions`,

  /**
   * Record a suppression. ON DUPLICATE KEY makes the webhook idempotent under
   * SNS's at-least-once delivery, and refreshes the reason so the most recent
   * cause is what the admin screen shows — a complaint after a bounce is worth
   * seeing.
   *
   * Parameters: [email (lowercased), reason, detail, ses_message_id]
   */
  upsert: `
    INSERT INTO email_suppressions (email, reason, detail, ses_message_id)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      reason         = VALUES(reason),
      detail         = VALUES(detail),
      ses_message_id = VALUES(ses_message_id),
      suppressed_at  = CURRENT_TIMESTAMP
  `,

  /** Suppressions with their reason, newest first — the admin view. */
  selectDetailed: `
    SELECT email, reason, detail, ses_message_id, suppressed_at
    FROM email_suppressions
    ORDER BY suppressed_at DESC, id DESC
  `,

  /**
   * Un-suppress, once the recipient has fixed their mailbox. Legitimate and
   * expected — suppression is advisory, not a permanent ban.
   * Parameters: [email (lowercased)]
   */
  remove: `DELETE FROM email_suppressions WHERE email = ?`,
}
