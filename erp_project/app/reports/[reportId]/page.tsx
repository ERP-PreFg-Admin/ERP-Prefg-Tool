import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { ApiError } from "@/lib/gateway/errors"
import { assertReportAccess } from "@/lib/services/reports/access"
import { parsePaginationParams } from "@/lib/pagination"
import OpenPoBookReport from "./OpenPoBookReport"
import FillRateReport from "./FillRateReport"
import InvoiceChecksReport from "./InvoiceChecksReport"
import DataQualityReport from "./DataQualityReport"

type SP = Record<string, string | string[] | undefined>

export default async function ReportPage({ params, searchParams }: {
  params: Promise<{ reportId: string }>
  searchParams: Promise<SP>
}) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const { reportId } = await params

  // The layout checked /reports; this adds the report's source page.
  let report
  try {
    report = await assertReportAccess(parseInt(session.user.id), session.user.roles, reportId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) redirect("/auth/unauthorized")
    notFound()
  }
  if (!report.built) notFound()

  const sp = await searchParams
  const { page, size, offset } = parsePaginationParams(sp, { page: 1, size: 50 })

  switch (report.id) {
    case "open-po-book":
      return <OpenPoBookReport userId={parseInt(session.user.id)} report={report} sp={sp} page={page} size={size} offset={offset} />
    case "mfg-fill-rate":
      return <FillRateReport userId={parseInt(session.user.id)} report={report} sp={sp} />
    case "invoice-checks":
      return <InvoiceChecksReport userId={parseInt(session.user.id)} report={report} sp={sp} page={page} size={size} offset={offset} />
    case "data-quality":
      return <DataQualityReport userId={parseInt(session.user.id)} roles={session.user.roles} report={report}
        check={typeof sp.check === "string" ? sp.check : null} />
    default:
      notFound()
  }
}
