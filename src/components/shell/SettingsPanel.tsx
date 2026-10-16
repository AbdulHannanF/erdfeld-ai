'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import {
  Settings,
  Sun,
  Moon,
  Monitor,
  Palette,
  Map,
  Ruler,
  Bot,
  Boxes,
  Eye,
  EyeOff,
  ExternalLink,
} from 'lucide-react'
import { useStore, type AppSettings } from '@/store/useStore'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Separator } from '@/components/ui/separator'
import { DEFAULT_MODELS } from '@/app/api/agent/lib/models'
import type { ProvidersStatus } from '@/app/api/agent/lib/providers'

// ---------------------------------------------------------------------------
// Settings section component
// ---------------------------------------------------------------------------

function SettingsSection({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand-text" />
        <h3 className="text-title text-foreground">{title}</h3>
      </div>
      <div className="space-y-4 pl-6">
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setting row with toggle
// ---------------------------------------------------------------------------

function SettingToggle({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className="text-body text-muted-foreground cursor-pointer">
          {label}
        </Label>
        <p className="text-caption text-muted-foreground mt-0.5 leading-snug">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="flex-shrink-0 mt-0.5"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setting row with select dropdown
// ---------------------------------------------------------------------------

function SettingSelect({
  id,
  label,
  description,
  value,
  onValueChange,
  options,
}: {
  id: string
  label: string
  description: string
  value: string
  onValueChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className="text-body text-muted-foreground cursor-pointer">
          {label}
        </Label>
        <p className="text-caption text-muted-foreground mt-0.5 leading-snug">{description}</p>
      </div>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} size="sm" className="w-[8.125rem] bg-muted/60 border-border text-muted-foreground">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-card border-border">
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-muted-foreground focus:text-foreground focus:bg-brand-500/10">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI Provider sub-section (self-contained)
// ---------------------------------------------------------------------------

const AI_PROVIDERS = [
  { value: 'default', label: 'Default (built-in)', hint: 'Uses the bundled Erdfeld AI model' },
  { value: 'claude', label: 'Claude (Anthropic)', hint: 'claude.ai API key required' },
  { value: 'openai', label: 'OpenAI', hint: 'api.openai.com key required' },
  { value: 'gemini', label: 'Google Gemini', hint: 'Google AI Studio key required' },
  { value: 'ollama', label: 'Ollama (local)', hint: 'Runs locally at localhost:11434' },
  { value: 'custom', label: 'Custom endpoint', hint: 'OpenAI-compatible API' },
] as const

/** What the server can run without a browser-held key (`GET /api/providers`); null until known
 *  or when the call fails, in which case the panel behaves as before (a key is required). */
function useServerProviders(): ProvidersStatus | null {
  const [status, setStatus] = useState<ProvidersStatus | null>(null)
  useEffect(() => {
    let live = true
    fetch('/api/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.providers) setStatus(j as ProvidersStatus) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  return status
}

function AIProviderSection() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const [showKey, setShowKey] = useState(false)
  const server = useServerProviders()

  const provider = settings.aiProvider
  const serverInfo = server?.providers.find((p) => p.id === provider)
  const serverKey = !!serverInfo?.server_key
  const clientKeysAllowed = server?.client_keys !== false
  // With a server key the field is optional; when the server refuses browser keys it is hidden.
  const needsKey = provider !== 'default' && provider !== 'ollama' && (clientKeysAllowed || !serverKey)
  const needsBaseUrl = provider === 'ollama' || provider === 'custom' || provider === 'claude'
  const needsModel = provider !== 'default'

  const selectedInfo = AI_PROVIDERS.find((p) => p.value === provider)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-brand-text" />
        <h3 className="text-title text-foreground">AI Model</h3>
      </div>
      <div className="space-y-4 pl-6">
        {/* Provider select */}
        <div className="space-y-1.5">
          <Label className="text-body text-muted-foreground">Provider</Label>
          <Select
            value={provider}
            onValueChange={(v) => updateSettings({ aiProvider: v as AppSettings['aiProvider'] })}
          >
            <SelectTrigger className="w-full bg-muted/60 border-border text-muted-foreground h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {AI_PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value} className="text-muted-foreground focus:text-foreground focus:bg-brand-500/10">
                  <span>{p.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedInfo && (
            <p className="text-caption text-muted-foreground">
              {provider === 'default' && server?.default_provider
                ? `Server default: ${server.default_provider}`
                : selectedInfo.hint}
            </p>
          )}
        </div>

        {/* Base URL (Ollama, custom, Claude override) */}
        {needsBaseUrl && (
          <div className="space-y-1.5">
            <Label className="text-body text-muted-foreground">
              {provider === 'ollama' ? 'Ollama URL' : 'Base URL'}
            </Label>
            <Input
              value={settings.aiBaseUrl}
              onChange={(e) => updateSettings({ aiBaseUrl: e.target.value })}
              placeholder={
                provider === 'ollama'
                  ? 'http://localhost:11434'
                  : provider === 'claude'
                  ? 'https://api.anthropic.com'
                  : 'https://your-api.example.com/v1'
              }
              className="h-9 bg-muted/60 border-border text-foreground placeholder:text-muted-foreground text-body focus-visible:ring-brand-500/50 focus-visible:border-brand-500/50"
            />
          </div>
        )}

        {/* API Key */}
        {needsKey && (
          <div className="space-y-1.5">
            <Label className="text-body text-muted-foreground">
              API Key{serverKey && <span className="ml-1 text-muted-foreground">(optional)</span>}
            </Label>
            {serverKey && (
              <p className="text-caption-strong text-success">
                Server key configured — leave this empty to use it, or enter your own.
              </p>
            )}
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                value={settings.aiApiKey}
                onChange={(e) => updateSettings({ aiApiKey: e.target.value })}
                placeholder="sk-..."
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="btn btn-ghost btn-icon-sm absolute right-0.5 top-1/2 -translate-y-1/2"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-caption text-muted-foreground">Stored locally in your browser only</p>
          </div>
        )}

        {provider !== 'default' && provider !== 'ollama' && serverKey && !clientKeysAllowed && (
          <p className="text-caption-strong text-success">
            Server key configured. This deployment does not accept keys from the browser.
          </p>
        )}

        {/* Model name */}
        {needsModel && (
          <div className="space-y-1.5">
            <Label className="text-body text-muted-foreground">Model</Label>
            <Input
              value={settings.aiModel}
              onChange={(e) => updateSettings({ aiModel: e.target.value })}
              placeholder={
                provider === 'ollama' || provider === 'openai' || provider === 'gemini' || provider === 'claude'
                  ? serverInfo?.default_model ?? DEFAULT_MODELS[provider]
                  : 'model-name'
              }
              className="h-9 bg-muted/60 border-border text-foreground placeholder:text-muted-foreground text-body font-mono focus-visible:ring-brand-500/50 focus-visible:border-brand-500/50"
            />
            <p className="text-caption text-muted-foreground">Leave blank to use the provider default</p>
          </div>
        )}

        {/* Ollama quickstart hint */}
        {provider === 'ollama' && (
          <div className="rounded-lg bg-brand-500/5 border border-brand-500/15 p-3 space-y-1">
            <p className="text-caption-strong text-brand-text">Ollama quickstart</p>
            <p className="text-data text-muted-foreground leading-relaxed">
              ollama pull llama3.2<br />
              ollama serve
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Perception models (Phase 1) — user-pluggable CV / detection models
// ---------------------------------------------------------------------------

const MODEL_PLACEHOLDER = `[
  {
    "id": "my_car_detector",
    "provider": "local-onnx",
    "ref": "https://huggingface.co/<owner>/<repo>/resolve/main/best.onnx",
    "task": "detect",
    "classes": ["car"],
    "input_size": 640,
    "profile": "tiny",
    "license": "AGPL-3.0",
    "resolution_m": 0.3
  }
]`

/** Registers extra detection models with the agent. The list travels with each
 *  query and is merged server-side with GEOAGENT_MODELS and the built-ins, so a
 *  model added here works immediately — no redeploy, no code change. */
function PerceptionModelsSection() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const value = settings.customModels ?? ''

  // Local, immediate feedback. The server validates authoritatively and returns
  // its own errors; this just catches the common "that is not JSON" case before
  // the user runs a query and waits.
  let parseError: string | null = null
  if (value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed)) parseError = 'Must be a JSON array of model specs.'
      else {
        const bad = parsed.find((m: unknown) => !m || typeof m !== 'object' || !(m as { id?: unknown }).id)
        if (bad) parseError = 'Every entry needs at least an "id", "provider", "ref" and "task".'
      }
    } catch {
      parseError = 'Not valid JSON.'
    }
  }

  return (
    <SettingsSection title="Perception Models" icon={Boxes}>
      <div className="space-y-1.5">
        <Label className="text-body text-muted-foreground">Custom models (JSON)</Label>
        <textarea
          value={value}
          onChange={(e) => updateSettings({ customModels: e.target.value })}
          placeholder={MODEL_PLACEHOLDER}
          spellCheck={false}
          rows={10}
          className="field font-mono"
        />
        {parseError ? (
          <p className="text-caption text-danger">{parseError}</p>
        ) : (
          <p className="text-caption text-muted-foreground">
            providers: <span className="font-mono">local-onnx</span> (weights URL or local path — no key, no rate limit),{' '}
            <span className="font-mono">roboflow</span>, <span className="font-mono">custom-http</span> (your own endpoint).
          </p>
        )}
        <p className="text-caption text-muted-foreground">
          Models declaring a <span className="font-mono">profile</span> heavier than this machine are skipped, and the
          agent says so rather than failing quietly.
        </p>
      </div>
    </SettingsSection>
  )
}

// ---------------------------------------------------------------------------
// Main SettingsPanel component
// ---------------------------------------------------------------------------

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

export default function SettingsSheet() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const open = useStore((s) => s.settingsPanelOpen)
  const setOpen = useStore((s) => s.setSettingsPanelOpen)
  const { setTheme, theme } = useTheme()

  const handleThemeChange = (newTheme: AppSettings['theme']) => {
    setTheme(newTheme)
    updateSettings({ theme: newTheme })
  }

  return (
    <>
      {/* Settings Sheet */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-[25rem] bg-card/95 border-l border-border p-0 flex flex-col gap-0"
        >
          <SheetHeader className="flex-shrink-0 px-5 pt-5 pb-3 border-b border-border">
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-brand-500/20 border border-brand-500/20">
                <Settings className="h-4 w-4 text-brand-text" />
              </div>
              <div>
                <SheetTitle>
                  Settings
                </SheetTitle>
                <SheetDescription className="text-caption text-muted-foreground mt-0.5">
                  Appearance, map readouts and the AI provider
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="flex flex-col gap-6 p-5">
              {/* ---- Appearance ---- */}
              <SettingsSection icon={Palette} title="Appearance">
                {/* Theme toggle */}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="min-w-[10rem] flex-1">
                    <Label className="text-body text-foreground">Theme</Label>
                    <p className="text-caption text-muted-foreground mt-0.5 leading-snug">
                      Follows your system unless you choose one
                    </p>
                  </div>
                  <div className="segmented" role="group" aria-label="Theme">
                    {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        onClick={() => handleThemeChange(value)}
                        aria-pressed={theme === value}
                      >
                        <Icon aria-hidden />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

              </SettingsSection>

              <Separator className="bg-foreground/[0.06]" />

              {/* ---- Map Defaults ---- */}
              <SettingsSection icon={Map} title="Map Readouts">
                <SettingToggle
                  id="show-coordinates"
                  label="Show Coordinates"
                  description="Display cursor coordinates on the map"
                  checked={settings.showCoordinates}
                  onCheckedChange={(v) => updateSettings({ showCoordinates: v })}
                />
                <SettingToggle
                  id="show-zoom-level"
                  label="Show Zoom Level"
                  description="Display the current zoom level indicator"
                  checked={settings.showZoomLevel}
                  onCheckedChange={(v) => updateSettings({ showZoomLevel: v })}
                />
              </SettingsSection>

              <Separator className="bg-foreground/[0.06]" />

              {/* ---- Units ---- */}
              <SettingsSection icon={Ruler} title="Units">
                <SettingSelect
                  id="distance-unit"
                  label="Distance Unit"
                  description="Unit system for distance measurements"
                  value={settings.distanceUnit}
                  onValueChange={(v) => updateSettings({ distanceUnit: v as AppSettings['distanceUnit'] })}
                  options={[
                    { value: 'metric', label: 'Metric (km, m)' },
                    { value: 'imperial', label: 'Imperial (mi, ft)' },
                  ]}
                />
                <SettingSelect
                  id="area-unit"
                  label="Area Unit"
                  description="Unit system for area calculations"
                  value={settings.areaUnit}
                  onValueChange={(v) => updateSettings({ areaUnit: v as AppSettings['areaUnit'] })}
                  options={[
                    { value: 'metric', label: 'Metric (km², m²)' },
                    { value: 'imperial', label: 'Imperial (mi², ac)' },
                  ]}
                />
              </SettingsSection>

              <Separator className="bg-foreground/[0.06]" />

              {/* ---- AI Provider ---- */}
              <AIProviderSection />

              <Separator className="bg-foreground/[0.06]" />

              {/* ---- Perception Models (Phase 1) ---- */}
              <PerceptionModelsSection />

              {/* Footer with version info */}
              <div className="pt-2 pb-4">
                <Separator className="bg-foreground/[0.06] mb-4" />
                <div className="flex items-center justify-between text-caption text-muted-foreground">
                  <span>Erdfeld AI v1.0.0</span>
                  <span>Settings saved automatically</span>
                </div>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
