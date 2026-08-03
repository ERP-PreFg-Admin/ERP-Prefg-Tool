"use client"

import { createContext, useCallback, useContext, useState } from "react"
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react"
import { cn } from "@/lib/utils"

type Variant = "success" | "error" | "info"

type ToastItem = {
  id: string
  title: string
  description?: string
  variant: Variant
}

type ToastFn = (opts: { title: string; description?: string; variant?: Variant }) => void

const ToastContext = createContext<{ toast: ToastFn } | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used inside ToastProvider")
  return ctx
}

const VARIANT_ICON: Record<Variant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error:   AlertCircle,
  info:    Info,
}

const VARIANT_STYLE: Record<Variant, string> = {
  success: "bg-teal-50 border-teal-200 text-teal-900 dark:bg-teal-900 dark:border-teal-700 dark:text-teal-50",
  error:   "bg-red-50 border-red-200 text-red-900 dark:bg-red-900 dark:border-red-700 dark:text-red-50",
  info:    "bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-900 dark:border-blue-700 dark:text-blue-50",
}

const VARIANT_ICON_STYLE: Record<Variant, string> = {
  success: "text-teal-600 dark:text-teal-400",
  error:   "text-red-600 dark:text-red-400",
  info:    "text-blue-600 dark:text-blue-400",
}

/** A single toast notification — used by ToastProvider's stack, one instance
 *  per active toast. */
export function Toast({ title, description, variant, onDismiss }: {
  title:       string
  description?: string
  variant:     Variant
  onDismiss:   () => void
}) {
  const Icon = VARIANT_ICON[variant]

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 shadow-xl text-sm max-w-sm w-full",
        "animate-in slide-in-from-bottom-2 fade-in duration-200",
        VARIANT_STYLE[variant]
      )}
    >
      <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", VARIANT_ICON_STYLE[variant])} />
      <div className="flex-1 min-w-0">
        <p className="font-medium leading-snug">{title}</p>
        {description && (
          <p className="text-xs opacity-75 mt-0.5">{description}</p>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity mt-0.5"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const toast = useCallback<ToastFn>(({ title, description, variant = "info" }) => {
    const id = Math.random().toString(36).slice(2, 9)
    setToasts((prev) => [...prev.slice(-3), { id, title, description, variant }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 z-9999 flex flex-col-reverse gap-2 pointer-events-none"
      >
        {toasts.map((t) => (
          <Toast
            key={t.id}
            title={t.title}
            description={t.description}
            variant={t.variant}
            onDismiss={() => dismiss(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
