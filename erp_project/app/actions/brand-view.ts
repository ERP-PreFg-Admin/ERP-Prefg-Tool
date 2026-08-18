"use server"

/**
 * Writes the platform-view cookie.
 *
 * Deliberately does NOT validate the ids against the user's grant. It doesn't
 * need to and shouldn't pretend to: getBrandView intersects the cookie with the
 * grant on every read (lib/brand-view.ts), so an unauthorised id here is inert.
 * Validating in both places would imply the cookie is trusted somewhere, which is
 * exactly the assumption that turns a filter into a privilege escalation.
 *
 * What it does enforce is shape — only positive integers reach the cookie, so a
 * hand-edited value can't inject anything into the comma-split parse.
 */

import { cookies } from "next/headers"
import { BRAND_VIEW_COOKIE } from "@/lib/brand-view"

export async function setBrandView(brandIds: number[]) {
  const clean = brandIds.filter((n) => Number.isInteger(n) && n > 0)
  const jar = await cookies()

  if (clean.length === 0) {
    // Empty selection means "no filter", not "show nothing" — the same
    // absence-means-unrestricted convention the grant itself uses. Clearing the
    // cookie is how that is expressed, so getBrandView sees null.
    jar.delete(BRAND_VIEW_COOKIE)
  } else {
    jar.set(BRAND_VIEW_COOKIE, clean.join(","), {
      httpOnly: true,   // nothing client-side reads it; the server passes the
                        // resolved view down as props instead
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    })
  }

  // Deliberately NO revalidatePath("/", "layout").
  //
  // Every scoped page resolves the view through getBrandView, which calls
  // cookies() — so those pages are already dynamic and have no cached output to
  // invalidate. revalidatePath was throwing away the whole tree on every change
  // for nothing, and it ran once per checkbox before the switcher batched them.
  //
  // The caller does a router.refresh() instead: it re-renders only the route the
  // user is actually looking at, and any other route re-reads the cookie when
  // navigated to.
}
