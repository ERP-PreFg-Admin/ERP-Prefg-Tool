// Who may open which report: /reports AND the report's source page, both at viewer level or above.
// Used by the catalogue, every report page and the export route, so all three agree.

import { resolveAccess } from "@/lib/permissions"
import { ApiError } from "@/lib/gateway/errors"
import { REPORTS, findReport, type ReportEntry } from "@/lib/reports/catalog"

async function canOpen(userId: number, roles: string[], r: ReportEntry): Promise<boolean> {
  if (!r.sourcePageSlug) return true
  return (await resolveAccess(userId, roles, r.sourcePageSlug)) !== "none"
}

/** Reports the viewer may open; assumes /reports itself was already checked by the layout. */
export async function getVisibleReports(userId: number, roles: string[]): Promise<ReportEntry[]> {
  const ok = await Promise.all(REPORTS.map((r) => canOpen(userId, roles, r)))
  return REPORTS.filter((_, i) => ok[i])
}

/** Throws 404 for an unknown id and 403 without /reports or the source page. */
export async function assertReportAccess(userId: number, roles: string[], reportId: string): Promise<ReportEntry> {
  const report = findReport(reportId)
  if (!report) throw new ApiError(404, "report_not_found", "No such report.")
  if ((await resolveAccess(userId, roles, "/reports")) === "none" || !(await canOpen(userId, roles, report))) {
    throw new ApiError(403, "report_forbidden", "You don't have access to this report.")
  }
  return report
}
