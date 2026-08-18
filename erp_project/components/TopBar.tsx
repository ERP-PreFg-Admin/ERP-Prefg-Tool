import { APP_NAME, APP_VERSION } from "@/lib/constants"

/** `right` is the platform-view switcher, passed in from the server layout —
 *  TopBar is rendered inside ClientLayout and cannot resolve the view itself. */
export default function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="h-14 border-b border-border px-6 flex items-center justify-between bg-background shrink-0">
      <span className="text-sm font-semibold text-foreground">{APP_NAME}</span>
      <div className="flex items-center gap-4">
        {right}
        <span className="text-xs font-medium text-muted-foreground tabular-nums">{APP_VERSION}</span>
      </div>
    </header>
  )
}
