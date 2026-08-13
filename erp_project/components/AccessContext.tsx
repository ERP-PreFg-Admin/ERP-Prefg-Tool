"use client"

/**
 * The current user's access level for the page they're on, available to any
 * client component without threading a prop through every page.
 *
 * The map is already resolved server-side in app/layout.tsx (one pass for every
 * sidebar destination) and handed to ClientLayout so the sidebar can lock what
 * the user can't reach. This just exposes that same map to everything below it.
 *
 * It is a UI affordance, NOT a security boundary. Every mutating route is
 * independently gated by withGateway's `access` rule — a viewer who calls the
 * API directly is still refused with 403. The point here is to say so before
 * someone fills in a form, rather than after.
 */

import { createContext, useCallback, useContext, useMemo } from "react"
import { usePathname } from "next/navigation"
import type { AccessLevel } from "@/lib/permissions"
import { useToast } from "@/components/ui/toast"

const AccessCtx = createContext<Record<string, AccessLevel>>({})

export function AccessProvider({
  access,
  children,
}: {
  access?: Record<string, AccessLevel>
  children: React.ReactNode
}) {
  const value = useMemo(() => access ?? {}, [access])
  return <AccessCtx.Provider value={value}>{children}</AccessCtx.Provider>
}

/**
 * Walk up to the nearest ancestor slug that has an entry, mirroring
 * resolveAccess's own parent walk on the server: `/masters/skus` inherits from
 * `/masters` when only the parent is granted. Without this a page whose exact
 * slug isn't in the map would read as "no access" and disable every button.
 */
function levelFor(access: Record<string, AccessLevel>, pathname: string): AccessLevel | undefined {
  let slug: string = pathname
  for (;;) {
    if (access[slug]) return access[slug]
    const cut = slug.lastIndexOf("/")
    if (cut <= 0) return undefined
    slug = slug.slice(0, cut)
  }
}

/**
 * Can the user change things on this page?
 *
 * Defaults to TRUE when the page has no entry at all — an unmapped page must
 * not silently disable its own buttons, and the server is the real gate. Only a
 * resolved "viewer" turns editing off.
 */
export function useCanEdit(): boolean {
  const access = useContext(AccessCtx)
  const pathname = usePathname()
  const level = levelFor(access, pathname ?? "")
  return level === undefined ? true : level === "editor"
}

/**
 * Guard for an action a viewer must not take.
 *
 *   const guard = useEditGuard()
 *   onClick={() => { if (!guard()) return; openDialog() }}
 *
 * Returns false and shows the toast when the user is view-only. Reading and
 * exporting deliberately don't call this — a viewer is allowed to look and to
 * download what they can already see.
 */
export function useEditGuard(): (action?: string) => boolean {
  const canEdit = useCanEdit()
  const { toast } = useToast()

  return useCallback(
    (action?: string) => {
      if (canEdit) return true
      toast({
        title: "Access denied",
        description: action
          ? `You have view-only access to this page, so you can't ${action}. Ask an admin for editor access.`
          : "You have view-only access to this page. Ask an admin for editor access to make changes.",
        variant: "error",
      })
      return false
    },
    [canEdit, toast]
  )
}
