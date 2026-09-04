"use client"

import { usePathname } from "next/navigation"
import Sidebar from "@/components/Sidebar"
import TopBar from "@/components/TopBar"
import { ToastProvider } from "@/components/ui/toast"
import { AccessProvider } from "@/components/AccessContext"
import { ScrollFade } from "@/components/ui/scroll-fade"
import type { AccessLevel } from "@/lib/permissions"
import type { BuildInfo } from "@/lib/build-info"

interface Props {
  children: React.ReactNode
  user?: { name?: string | null; email?: string | null }
  mfgs?: { id: number; name: string }[]
  /** Rendered in the top bar — the platform-view switcher, built server-side. */
  topBarRight?: React.ReactNode
  access?: Record<string, AccessLevel>
  /** What this container is — read from the server env in app/layout.tsx, same
   *  values /api/health reports. Rendered by TopBar. */
  build?: BuildInfo
}

const AUTH_ROUTES = ["/auth/"]

export default function ClientLayout({ children, user, mfgs, access, topBarRight, build }: Props) {
  const pathname = usePathname()
  const isAuthPage = AUTH_ROUTES.some(r => pathname.startsWith(r))

  if (isAuthPage) return <>{children}</>

  return (
    // AccessProvider inside ToastProvider: useEditGuard shows its refusal as a
    // toast, so it needs the toast context above it.
    <ToastProvider>
      <AccessProvider access={access}>
        <div className="flex h-screen overflow-hidden bg-background">
          <Sidebar user={user} mfgs={mfgs} access={access} version={build?.version} />
          <div className="flex flex-col flex-1 overflow-hidden">
            <TopBar right={topBarRight} build={build} />
            <main className="flex-1 overflow-hidden">
              <ScrollFade axis="y" className="h-full">{children}</ScrollFade>
            </main>
          </div>
        </div>
      </AccessProvider>
    </ToastProvider>
  )
}
