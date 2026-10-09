// Send a user's welcome mail and stamp users.welcome_sent_at. Call after commit, never inside a transaction.
import { query, execute } from "@/lib/db"
import { usersSql } from "@/lib/queries/users"
import { sendWelcomeEmail } from "@/lib/mail/mailer"
import logger from "@/lib/logger"

export type WelcomeResult = "sent" | "failed" | "skipped"

export async function deliverWelcome(user: { id: number; name: string; email: string }, adminId: number | null): Promise<WelcomeResult> {
  if (adminId == null) return "failed"
  try {
    const [admin] = await query<{ name: string; email: string }>(usersSql.selectContactById, [adminId])
    if (!admin) return "failed"
    const out = await sendWelcomeEmail({ user, admin })
    if (!out.sent) return "failed"
    await execute(usersSql.markWelcomeSent, [user.id])
    return "sent"
  } catch (err) {
    logger.error({ module: "ADMIN_USERS", userId: user.id, error: (err as Error)?.message, message: "Welcome delivery failed" })
    return "failed"
  }
}
