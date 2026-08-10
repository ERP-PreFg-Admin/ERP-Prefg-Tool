import { APP_NAME, APP_VERSION } from "@/lib/constants"

export default function TopBar() {
  return (
    <header className="h-14 border-b border-border px-6 flex items-center justify-between bg-background shrink-0">
      <span className="text-sm font-semibold text-foreground">{APP_NAME}</span>
      <span className="text-xs font-medium text-muted-foreground tabular-nums">{APP_VERSION}</span>
    </header>
  )
}
