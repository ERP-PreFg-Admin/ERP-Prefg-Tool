import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import { redirect } from "next/navigation"
import { parseIso } from "@/lib/date"
import {
  getDispatchLines, getFacilityMap, getMfgOptions, getOpenPoCells,
} from "@/lib/services/mfg-overview"
import { MfgFacilityMatrix } from "./MfgFacilityMatrix"
import { MfgOverviewTabs } from "./MfgOverviewTabs"
import { OpenPosMatrix } from "./OpenPosMatrix"
import { DispatchHistory } from "./DispatchHistory"
import { parseTab, presetRange } from "./overview-model"

export const dynamic = "force-dynamic"

type SearchParams = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ""

export default async function ManufacturingOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const userId = parseInt(session.user.id)
  const access = await resolveAccess(userId, session.user.roles, "/po-tracking/mfg-overview")
  if (access === "none") redirect("/auth/unauthorized")

  const sp = await searchParams
  // The tab lives in the URL: the mapping matrix calls router.refresh() after a save.
  const tab = parseTab(one(sp.tab))

  let body: React.ReactNode
  if (tab === "open") {
    body = <OpenPosMatrix cells={await getOpenPoCells(userId)} />
  } else if (tab === "dispatch") {
    const fallback = presetRange("D-1")
    let from = parseIso(one(sp.from)) ? one(sp.from) : fallback.from
    let to = parseIso(one(sp.to)) ? one(sp.to) : fallback.to
    if (from > to) [from, to] = [to, from]
    const mfgId = Number(one(sp.mfg)) || null
    const [lines, mfgOptions] = await Promise.all([
      getDispatchLines(userId, { from, to, mfgId }),
      getMfgOptions(userId),
    ])
    body = <DispatchHistory lines={lines} mfgOptions={mfgOptions} from={from} to={to} mfgId={mfgId} />
  } else {
    const { cells, lines, mappings } = await getFacilityMap(userId)
    body = <MfgFacilityMatrix cells={cells} lines={lines} mappings={mappings} canEdit={access === "editor"} />
  }

  return (
    <div className="p-6 space-y-4">
      <MfgOverviewTabs active={tab} />
      {body}
    </div>
  )
}
