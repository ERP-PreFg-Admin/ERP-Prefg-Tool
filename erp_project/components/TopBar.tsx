import { APP_NAME, PRODUCT_NAME } from "@/lib/constants"
import type { BuildInfo } from "@/lib/build-info"

/** `right` is the platform-view switcher, passed in from the server layout —
 *  TopBar is rendered inside ClientLayout and cannot resolve the view itself.
 *
 *  `build` arrives the same way: read from the server env in app/layout.tsx (it
 *  cannot be a NEXT_PUBLIC_ var — see the note there) and drilled down. */
export default function TopBar({ right, build }: { right?: React.ReactNode; build?: BuildInfo }) {
  const isProd = build?.env === "prod"

  return (
    <header className="h-14 border-b border-border px-6 flex items-center justify-between bg-background shrink-0">
      <span className="text-sm font-semibold text-foreground">{APP_NAME}</span>
      <div className="flex items-center gap-4">
        {right}
        <div className="flex items-center gap-2">
          {/* Only off prod. A badge that is always present stops being read, and
              the point is to make "this is NOT prod" impossible to miss when two
              tabs are open side by side. */}
          {build && !isProd && (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400"
              title={`Environment: ${build.env}`}
            >
              {build.env}
            </span>
          )}

          {/* Build age is shown off prod only, and it is the actual mismatch
              detector: the box pulls a MOVING image tag, so a deploy that failed
              to land leaves the old container running and a commit SHA nobody
              memorised looks exactly as correct as the right one. "3d ago" right
              after you deployed does not. Prod carries a distinct release tag
              (v1.0.0 -> v1.0.1), so the drift is already visible there. */}
          <span
            className="text-xs font-medium text-muted-foreground tabular-nums"
            title={build?.builtAt ? `Built ${build.builtAt}` : "Build version"}
          >
            {build?.version ? `${PRODUCT_NAME} ${build.version}` : PRODUCT_NAME}
            {!isProd && build?.age ? ` · ${build.age}` : ""}
          </span>
        </div>
      </div>
    </header>
  )
}
