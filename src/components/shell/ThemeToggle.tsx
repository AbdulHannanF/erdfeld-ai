'use client'

import { useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useStore, type AppSettings } from '@/store/useStore'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/shell/Segmented'

const subscribe = () => () => {}

/** Theme choice: System, Light or Dark. The trigger shows the theme in effect; System follows the
 *  operating system and is the default. */
export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const updateSettings = useStore((s) => s.updateSettings)
  // next-themes only knows the theme after mount; until then render the neutral icon.
  const mounted = useSyncExternalStore(subscribe, () => true, () => false)
  const Icon = !mounted ? Monitor : resolvedTheme === 'light' ? Sun : Moon

  const choose = (next: AppSettings['theme']) => {
    setTheme(next)
    updateSettings({ theme: next })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Theme"
          title="Theme"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon className="size-[1.0625rem]" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-auto p-1.5">
        <Segmented
          label="Theme"
          value={(mounted ? (theme as AppSettings['theme']) : 'system') ?? 'system'}
          onChange={choose}
          options={[
            { value: 'system', label: <><Monitor className="size-3.5" aria-hidden />System</> },
            { value: 'light', label: <><Sun className="size-3.5" aria-hidden />Light</> },
            { value: 'dark', label: <><Moon className="size-3.5" aria-hidden />Dark</> },
          ]}
        />
      </PopoverContent>
    </Popover>
  )
}
