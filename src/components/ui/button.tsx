import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** The one button. Variants and sizes are the `.btn-*` classes in globals.css (section 5b), so a
 *  raw <button className="btn btn-ghost btn-icon-sm"> and <Button variant="ghost" size="icon-sm">
 *  are the same control. */
const buttonVariants = cva("btn", {
  variants: {
    variant: {
      primary: "btn-primary",
      secondary: "btn-secondary",
      ghost: "btn-ghost",
      danger: "btn-danger",
    },
    size: {
      sm: "btn-sm",
      md: "btn-md",
      "icon-sm": "btn-icon-sm",
      "icon-md": "btn-icon-md",
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "md",
  },
})

function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
