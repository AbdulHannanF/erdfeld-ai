import * as React from "react"

import { cn } from "@/lib/utils"

/** A text field: the `.field` class in globals.css (section 5b), 32px high, `size="sm"` 28px. */
function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "sm" | "md" }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn("field", size === "sm" && "field-sm", className)}
      {...props}
    />
  )
}

export { Input }
