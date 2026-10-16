'use client'

import { X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ICON_BTN, OVERLINE } from '@/components/shell/ui'
import { cn } from '@/lib/utils'

/** A workbench dialog: kicker, title and close in the head, a scrolling body, a foot of actions.
 *  Radix supplies the focus trap, Escape, scroll lock and the return of focus to the opener. */
export function WbDialog({
  open,
  onClose,
  kicker,
  title,
  description,
  children,
  foot,
  wide = false,
  testId,
}: {
  open: boolean
  onClose: () => void
  kicker: string
  title: string
  /** Read by assistive technology as the dialog's description; also shown when `showDescription`. */
  description: string
  children: React.ReactNode
  foot?: React.ReactNode
  wide?: boolean
  testId?: string
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        data-testid={testId}
        className={cn(
          'flex max-h-[min(82dvh,47.5rem)] flex-col gap-0 overflow-hidden rounded-[0.5625rem] border-[#43504a] bg-popover p-0 shadow-[0_1.5625rem_5.625rem_#000a] sm:max-w-none',
          wide ? 'w-[min(45rem,calc(100vw-1.75rem))]' : 'w-[min(29.375rem,calc(100vw-1.75rem))]',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 pb-3 pt-3.5">
          <div className="min-w-0">
            <div className={OVERLINE}>{kicker}</div>
            <DialogTitle className="mt-1 font-heading text-[1.0625rem] font-semibold leading-snug text-foreground">{title}</DialogTitle>
          </div>
          <button type="button" onClick={onClose} className={ICON_BTN} aria-label={`Close ${title}`}>
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto px-4 py-3.5">{children}</div>
        {foot && <footer className="flex flex-wrap justify-end gap-1.5 border-t border-border px-4 py-2.5">{foot}</footer>}
      </DialogContent>
    </Dialog>
  )
}

/** The design's bordered callout inside a dialog. */
export function Callout({ icon, children, tone = 'info', className }: { icon?: React.ReactNode; children: React.ReactNode; tone?: 'info' | 'warn' | 'bad'; className?: string }) {
  return (
    <div
      role={tone === 'info' ? undefined : 'status'}
      className={cn(
        'flex gap-2 rounded-[0.3125rem] border px-2.5 py-2 text-[0.8125rem] leading-snug',
        tone === 'info' && 'border-border bg-sunk text-muted-foreground',
        tone === 'warn' && 'border-warning/40 bg-warning/10 text-foreground',
        tone === 'bad' && 'border-danger/40 bg-danger/10 text-foreground',
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0 [&_svg]:size-4 [&_svg]:text-[#b7c994]">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  )
}
