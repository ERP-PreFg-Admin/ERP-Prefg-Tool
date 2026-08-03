import * as React from "react"
import { CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

export interface StepperStep {
  label: string
  tag?: string
  tagVariant?: "info" | "success" | "warning"
}

const TAG_VARIANT_CLASSES: Record<NonNullable<StepperStep["tagVariant"]>, string> = {
  info: "bg-blue-100 text-blue-700",
  success: "bg-teal-100 text-teal-700",
  warning: "bg-amber-100 text-amber-700",
}

function Stepper({
  steps,
  currentStep,
  className,
}: {
  steps: StepperStep[]
  currentStep: number
  className?: string
}) {
  return (
    <div data-slot="stepper" className={cn("flex items-center", className)}>
      {steps.map((step, i) => {
        const stepNum = i + 1
        const done = stepNum < currentStep
        const active = stepNum === currentStep
        const isLast = i === steps.length - 1
        return (
          <div key={step.label} className="flex items-center">
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0",
                  done && "bg-teal-600 text-white",
                  active && "bg-foreground text-background",
                  !done && !active && "border border-muted-foreground text-muted-foreground"
                )}
              >
                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : stepNum}
              </div>
              <span className={cn("text-sm whitespace-nowrap", active ? "font-medium" : "text-muted-foreground")}>
                {step.label}
              </span>
              {step.tag && (
                <span
                  className={cn(
                    "text-xs font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap",
                    step.tagVariant ? TAG_VARIANT_CLASSES[step.tagVariant] : undefined
                  )}
                >
                  {step.tag}
                </span>
              )}
            </div>
            {!isLast && <div className="h-px w-6 bg-border mx-3 shrink-0" />}
          </div>
        )
      })}
    </div>
  )
}

export { Stepper }
