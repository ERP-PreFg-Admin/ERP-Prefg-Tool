
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { resolveAccess } from "@/lib/permissions"
import ObservabilityTabs from "./ObservabilityTabs"

export default async function ObservabilityLayout({ children, }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect("/auth/signin")
  const access = await resolveAccess(
    parseInt(session.user.id),
    session.user.roles,
    "/observability"
  )
  if (access === "none") redirect("/auth/unauthorized")

  return (
    <div className="p-6">
      <header className="mb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="font-heading text-2xl font-bold tracking-tight">Observability</h1>
          <span className="text-xs text-muted-foreground">
            Request metrics from <code className="font-mono">activity_log</code> · host metrics from CloudWatch
          </span>
        </div>
      </header>

      <ObservabilityTabs />
      <div className="mt-5">{children}</div>
    </div>
  )
}