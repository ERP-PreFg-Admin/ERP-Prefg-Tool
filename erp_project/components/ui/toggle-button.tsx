import * as React from "react"
import { Button, type buttonVariants } from "@/components/ui/button"
import type { VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

function ToggleButton({
  className,
  pressed = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { pressed?: boolean }) {
  return (
    <Button
      variant="outline"
      data-slot="toggle-button"
      aria-pressed={pressed}
      className={cn(
        pressed &&
          "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
        className
      )}
      {...props}
    />
  )
}

export { ToggleButton }
