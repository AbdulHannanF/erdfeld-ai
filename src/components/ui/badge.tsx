import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** A count or a status tag (`.badge-*` in globals.css, section 5b). Not interactive: a filter
 *  that selects is a `.chip` button. */
const badgeVariants = cva("badge", {
  variants: {
    variant: {
      neutral: "",
      accent: "badge-accent",
      success: "badge-success",
      warning: "badge-warning",
      danger: "badge-danger",
      info: "badge-info",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
})

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
