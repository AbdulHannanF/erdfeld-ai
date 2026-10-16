'use client'

import { useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Crosshair, Map, Mountain, Columns, Camera, Upload, Maximize2, 
  Plus, Trash2, Search, Download, Clock, Brain, BarChart3,
  Settings, Keyboard, Satellite, Building2, Thermometer,
  CloudSun, Zap, 
} from 'lucide-react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@/components/ui/command'
import { useStore } from '@/store/useStore'
import { STORAGE_KEYS, readStorage, writeJson } from '@/lib/storage'

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

interface CommandDef {
  id: string
  label: string
  icon: React.ElementType
  shortcut?: string
  category: 'map' | 'chat' | 'navigation' | 'queries'
  action: () => void
}

// ---------------------------------------------------------------------------
// Recent commands tracking (localStorage)
// ---------------------------------------------------------------------------

function loadRecentCommands(): string[] {
  try {
    const stored = readStorage(STORAGE_KEYS.recentCommands)
    if (stored) return JSON.parse(stored)
  } catch {}
  return []
}

function saveRecentCommands(ids: string[]) {
  writeJson(STORAGE_KEYS.recentCommands, ids.slice(0, 5))
}

// ---------------------------------------------------------------------------
// CommandPalette component
// ---------------------------------------------------------------------------

export default function CommandPalette() {
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)

  // Store selectors for executing commands
  const setMapStyle = useStore((s) => s.setMapStyle)
  const setMapFullscreen = useStore((s) => s.setMapFullscreen)
  const clearMessages = useStore((s) => s.clearMessages)
  const setThinkingExpanded = useStore((s) => s.setThinkingExpanded)
  const isMapFullscreen = useStore((s) => s.isMapFullscreen)

  const recentRef = useRef<string[]>(loadRecentCommands())

  // Build commands list
  const commands: CommandDef[] = useMemo(() => [
    // ---- Map Actions ----
    {
      id: 'map-fly-to',
      label: 'Fly to coordinates',
      icon: Crosshair,
      shortcut: undefined,
      category: 'map',
      action: () => {
        window.dispatchEvent(new CustomEvent('open-coordinate-input'))
      },
    },
    {
      id: 'map-style-dark',
      label: 'Switch map style: Dark',
      icon: Map,
      category: 'map',
      action: () => setMapStyle('dark'),
    },
    {
      id: 'map-style-light',
      label: 'Switch map style: Light',
      icon: Map,
      category: 'map',
      action: () => setMapStyle('light'),
    },
    {
      id: 'map-style-streets',
      label: 'Switch map style: Streets',
      icon: Map,
      category: 'map',
      action: () => setMapStyle('streets'),
    },
    {
      id: 'map-style-satellite',
      label: 'Switch map style: Satellite',
      icon: Satellite,
      category: 'map',
      action: () => setMapStyle('satellite'),
    },
    {
      id: 'map-terrain',
      label: 'Toggle 3D terrain',
      icon: Mountain,
      category: 'map',
      action: () => {
        window.dispatchEvent(new CustomEvent('toggle-terrain'))
      },
    },
    {
      id: 'map-compare',
      label: 'Toggle compare view',
      icon: Columns,
      category: 'map',
      action: () => {
        window.dispatchEvent(new CustomEvent('toggle-compare'))
      },
    },
    {
      id: 'map-screenshot',
      label: 'Take screenshot',
      icon: Camera,
      category: 'map',
      action: () => {
        window.dispatchEvent(new CustomEvent('take-screenshot'))
      },
    },
    {
      id: 'map-upload-geojson',
      label: 'Import vector data',
      icon: Upload,
      category: 'map',
      action: () => {
        window.dispatchEvent(new CustomEvent('upload-geojson'))
      },
    },
    {
      id: 'map-fullscreen',
      label: isMapFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen',
      icon: Maximize2,
      shortcut: 'F',
      category: 'map',
      action: () => setMapFullscreen(!isMapFullscreen),
    },




    // ---- Chat Actions ----
    {
      id: 'chat-new-session',
      label: 'New session',
      icon: Plus,
      category: 'chat',
      action: () => {
        window.dispatchEvent(new CustomEvent('new-session'))
      },
    },
    {
      id: 'chat-clear',
      label: 'Clear chat',
      icon: Trash2,
      category: 'chat',
      action: () => {
        clearMessages()
      },
    },

    {
      id: 'chat-export',
      label: 'Export analysis',
      icon: Download,
      category: 'chat',
      action: () => {
        window.dispatchEvent(new CustomEvent('open-export'))
      },
    },
    {
      id: 'chat-history',
      label: 'Open chat history',
      icon: Clock,
      category: 'chat',
      action: () => {
        window.dispatchEvent(new CustomEvent('open-chat-history'))
      },
    },
    {
      id: 'chat-thinking',
      label: 'Toggle thinking trace',
      icon: Brain,
      category: 'chat',
      action: () => {
        const state = useStore.getState()
        setThinkingExpanded(!state.isThinkingExpanded)
      },
    },
    {
      id: 'chat-statistics',
      label: 'Toggle statistics charts',
      icon: BarChart3,
      category: 'chat',
      action: () => {
        window.dispatchEvent(new CustomEvent('toggle-statistics'))
      },
    },

    // ---- Navigation ----
    {
      id: 'nav-settings',
      label: 'Open settings',
      icon: Settings,
      category: 'navigation',
      action: () => {
        window.dispatchEvent(new CustomEvent('open-settings'))
      },
    },

    {
      id: 'nav-shortcuts',
      label: 'Keyboard shortcuts reference',
      icon: Keyboard,
      category: 'navigation',
      action: () => {
        useStore.getState().setShowShortcuts(true)
      },
    },



    // ---- Quick Queries ----
    {
      id: 'query-vegetation',
      label: 'Analyze vegetation',
      icon: Zap,
      category: 'queries',
      action: () => {
        window.dispatchEvent(new CustomEvent('quick-query', { detail: 'What is the vegetation health in this area?' }))
      },
    },
    {
      id: 'query-infrastructure',
      label: 'Map infrastructure',
      icon: Building2,
      category: 'queries',
      action: () => {
        window.dispatchEvent(new CustomEvent('quick-query', { detail: 'Show me buildings and roads in this area' }))
      },
    },
    {
      id: 'query-flood',
      label: 'Map flooding',
      icon: Search,
      category: 'queries',
      action: () => {
        window.dispatchEvent(new CustomEvent('quick-query', { detail: 'What went under water here, and what did it hit?' }))
      },
    },
    {
      id: 'query-elevation',
      label: 'Elevation analysis',
      icon: Mountain,
      category: 'queries',
      action: () => {
        window.dispatchEvent(new CustomEvent('quick-query', { detail: 'What is the elevation and terrain like here?' }))
      },
    },
    {
      id: 'query-temperature',
      label: 'Temperature analysis',
      icon: Thermometer,
      category: 'queries',
      action: () => {
        window.dispatchEvent(new CustomEvent('quick-query', { detail: 'What is the land surface temperature?' }))
      },
    },
    {
      id: 'query-weather',
      label: 'Weather data',
      icon: CloudSun,
      category: 'queries',
      action: () => {
        window.dispatchEvent(new CustomEvent('quick-query', { detail: 'What is the historical weather data for this area?' }))
      },
    },
  ], [setMapStyle, setMapFullscreen, clearMessages, setThinkingExpanded, isMapFullscreen])

  // Group commands by category
  const groupedCommands = useMemo(() => {
    const groups: Record<string, CommandDef[]> = {
      map: [],
      chat: [],
      navigation: [],
      queries: [],
    }
    for (const cmd of commands) {
      if (groups[cmd.category]) {
        groups[cmd.category].push(cmd)
      }
    }
    return groups
  }, [commands])

  // Recent commands
  const recentCommands = useMemo(() => {
    const recentIds = loadRecentCommands()
    return recentIds
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is CommandDef => c !== undefined)
  }, [commands])

  // Execute a command
  const executeCommand = useCallback((cmd: CommandDef) => {
    // Track recent
    const recent = recentRef.current.filter((id) => id !== cmd.id)
    recent.unshift(cmd.id)
    recentRef.current = recent.slice(0, 5)
    saveRecentCommands(recentRef.current)

    // Execute
    cmd.action()

    // Close palette
    setCommandPaletteOpen(false)
  }, [setCommandPaletteOpen])

  // Global Ctrl+K handler to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(!commandPaletteOpen)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [commandPaletteOpen, setCommandPaletteOpen])

  const categoryLabels: Record<string, string> = {
    map: 'Map Actions',
    chat: 'Chat Actions',
    navigation: 'Navigation',
    queries: 'Quick Queries',
  }

  return (
    <CommandDialog
      open={commandPaletteOpen}
      onOpenChange={setCommandPaletteOpen}
      title="Command Palette"
      description="Search for a command to run..."
      showCloseButton={false}
      className="top-[20%] translate-y-0 sm:max-w-[35rem] bg-popover/90 border border-border shadow-2xl [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:text-foreground [&_[cmdk-input]]:text-foreground [&_[cmdk-input]]:placeholder:text-muted-foreground [&_[cmdk-item]]:text-muted-foreground [&_[cmdk-item]_svg]:text-muted-foreground data-[selected=true]:bg-brand-500/15 data-[selected=true]:text-brand-text [&_[cmdk-item][data-selected=true]]:bg-brand-500/15 [&_[cmdk-item][data-selected=true]]:text-brand-text [&_[cmdk-item][data-selected=true]_svg]:text-brand-text [&_[cmdk-empty]]:text-muted-foreground [&_[cmdk-list]]:max-h-[22.5rem]"
    >
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Recent commands */}
        {recentCommands.length > 0 && (
          <CommandGroup heading="Recent">
            {recentCommands.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={`${cmd.label} ${cmd.category}`}
                onSelect={() => executeCommand(cmd)}
                className="flex items-center gap-3 cursor-pointer rounded-lg px-3 py-2.5 transition-colors data-[selected=true]:bg-brand-500/15 data-[selected=true]:text-brand-text"
              >
                <cmd.icon className="h-4 w-4 text-muted-foreground data-[selected=true]:text-brand-text shrink-0" />
                <span className="flex-1 text-sm">{cmd.label}</span>
                {cmd.shortcut && (
                  <CommandShortcut className="text-xs text-muted-foreground font-mono">
                    {cmd.shortcut}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Grouped commands */}
        {Object.entries(groupedCommands).map(([category, cmds]) => (
          <CommandGroup key={category} heading={categoryLabels[category] || category}>
            {cmds.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={`${cmd.label} ${cmd.category}`}
                onSelect={() => executeCommand(cmd)}
                className="flex items-center gap-3 cursor-pointer rounded-lg px-3 py-2.5 transition-colors data-[selected=true]:bg-brand-500/15 data-[selected=true]:text-brand-text"
              >
                <cmd.icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="flex-1 text-sm">{cmd.label}</span>
                {cmd.shortcut && (
                  <CommandShortcut className="text-xs text-muted-foreground font-mono">
                    {cmd.shortcut}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>

      {/* Footer hint */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border">
        <span className="text-xs text-muted-foreground">
          <kbd className="px-1 py-0.5 rounded bg-foreground/5 border border-border text-xs font-mono mr-1">↑↓</kbd>
          navigate
          <kbd className="px-1 py-0.5 rounded bg-foreground/5 border border-border text-xs font-mono mx-1">↵</kbd>
          select
          <kbd className="px-1 py-0.5 rounded bg-foreground/5 border border-border text-xs font-mono mx-1">esc</kbd>
          close
        </span>
        <span className="text-xs text-muted-foreground">
          {commands.length} commands
        </span>
      </div>
    </CommandDialog>
  )
}
