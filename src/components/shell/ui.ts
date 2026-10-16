/**
 * Class strings the workbench shares, so one control looks the same wherever it appears. Sizes are
 * the design's scaled to a 12px floor: its 7-9px text is 12-13px here and its 10-13px is 13-15px.
 */

/** Mono overline: the small tracked caps over a panel or field. */
export const OVERLINE = 'font-mono text-xs uppercase tracking-[0.09em] text-muted-foreground'

/** A bordered button in the top bar and dialogs (the design's .top-action / .dialog-btn). */
export const BTN =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[0.3125rem] border border-input bg-secondary px-2.5 text-[0.8125rem] text-secondary-foreground transition-colors hover:border-[#52635a] hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-45'

/** The green primary action (Export, Run, Apply). */
export const BTN_PRIMARY =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[0.3125rem] border border-[#3d8d67] bg-primary px-2.5 text-[0.8125rem] font-medium text-primary-foreground transition-colors hover:border-[#65bd8b] hover:bg-[#2f875f] disabled:pointer-events-none disabled:opacity-45'

/** A 32px square icon button with no frame until hover (panel headers, dock actions). */
export const ICON_BTN =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-45'

/** Floating map chrome: the dark glass the design uses over the map. */
export const GLASS =
  'border border-[color-mix(in_srgb,var(--foreground)_12%,transparent)] bg-[color-mix(in_srgb,var(--card)_92%,transparent)] backdrop-blur-[0.875rem] shadow-[0_0.5rem_1.75rem_#0003]'

/** Text input and select in dialogs and panels. */
export const FIELD =
  'h-8 w-full min-w-0 rounded-[0.3125rem] border border-input bg-secondary px-2 text-[0.8125rem] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:opacity-50'

/** Small mono pill (counts, status). */
export const PILL = 'inline-flex items-center rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground'
