import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/** The type roles of globals.css are font sizes to the merge: without this, `text-title` reads as a
 *  text colour and a later `text-foreground` silently removes it. `label` and `data` are the two
 *  roles that also set a family and case; they replace a size the same way. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "caption-strong", "body", "body-strong", "title", "section", "panel", "display", "label", "data"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
