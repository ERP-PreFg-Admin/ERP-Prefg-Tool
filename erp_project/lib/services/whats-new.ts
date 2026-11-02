// The "What's new" popup: this release's reviewed notes (stamped in by the deploy) and whether the user has dismissed them.

import { query, execute } from "@/lib/db"
import { usersSql } from "@/lib/queries/users"
import logger from "@/lib/logger"
import current from "@/lib/release-notes/current.json"

export type WhatsNewItem = { kind: "new" | "fixed"; area: string; text: string }
export type WhatsNew = { version: string; date: string | null; items: WhatsNewItem[] }

/** This release's notes, or null when there are none or the user already dismissed them. */
export async function getWhatsNew(userId: number): Promise<WhatsNew | null> {
  const notes = current as { version: string | null; date: string | null; items: WhatsNewItem[] }
  if (!notes.version || notes.items.length === 0) return null
  try {
    const [row] = await query<{ whats_new_seen: string | null }>(usersSql.selectWhatsNewSeen, [userId])
    if (!row || row.whats_new_seen === notes.version) return null
  } catch (err) {
    // The shell must render even if the column is missing; the popup just stays away.
    logger.warn({ userId, err: err instanceof Error ? err.message : String(err), message: "whats-new: seen-state read failed" })
    return null
  }
  return { version: notes.version, date: notes.date, items: notes.items }
}

/** Records the dismissal; only the release that is actually live can be marked. */
export async function markWhatsNewSeen(userId: number, version: string): Promise<boolean> {
  if (version !== (current as { version: string | null }).version) return false
  await execute(usersSql.setWhatsNewSeen, [version, userId])
  return true
}
