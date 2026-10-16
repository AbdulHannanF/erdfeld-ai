'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as maplibregl from '@/lib/maplibre'
import { BarChart3, CalendarRange, ChevronLeft, ChevronRight, Columns2, FlaskConical, Loader2, Pause, Play, RotateCw, X } from 'lucide-react'
import { toast } from 'sonner'

import MapTimelineSlider from '@/components/map/MapTimelineSlider'
import { Segmented } from '@/components/shell/Segmented'
import { BTN_SM, ICON_BTN_SM, OVERLINE } from '@/components/shell/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { useRunOperation } from '@/hooks/useRunOperation'
import { humanName, loadOperations, type OperationInfo } from '@/lib/operations-client'
import { isDatePinnable, planPins } from '@/lib/scene-pins'
import { dayLabel, geometryBbox, nearestSceneIndex, prefetchTiles, SENSOR_LABEL, tilesFor, type SceneRecord, type SceneRender, type SceneSensor } from '@/lib/scenes-client'
import { cn } from '@/lib/utils'
import { useJobs } from '@/store/useJobs'
import { useStore } from '@/store/useStore'
import { useUi } from '@/store/useUi'
import { currentScene, loadKey, SPEEDS, TIMELINE_LAYER_ID, useTimeline, type SeriesRow } from '@/store/useTimeline'
import VegaChart from '@/components/answer/VegaChart'

/** Frames play at this pace at 1x; a frame needs its tiles, so slower than a video. */
const FRAME_MS = 900
const SENSORS: { value: SceneSensor; label: string }[] = [
  { value: 'sentinel-2', label: 'Sentinel-2' },
  { value: 'landsat', label: 'Landsat' },
  { value: 'sentinel-1', label: 'Sentinel-1' },
]
const CLOUDS = [100, 60, 40, 20, 10]

function sceneCaption(s: SceneRecord): string {
  const cloud = s.cloudPct != null ? `${Math.round(s.cloudPct)}% scene cloud` : s.sensor === 'sentinel-1' ? 'radar, sees through cloud' : 'cloud not listed'
  return `${dayLabel(s.date)} · ${SENSOR_LABEL[s.sensor]} · ${cloud}`
}

// ---------------------------------------------------------------------------
// The layer: one id on the map, its tile URL swapped as the frame changes.
// ---------------------------------------------------------------------------

function useTimelineLayer(map: maplibregl.Map | null) {
  const list = useTimeline((s) => s.list)
  const index = useTimeline((s) => s.index)
  const playing = useTimeline((s) => s.playing)
  const aoi = useStore((s) => s.aoi)
  const scene = list?.scenes[index] ?? null
  const bbox = useMemo(() => geometryBbox(aoi?.geometry), [aoi])

  useEffect(() => {
    const { addLayer, removeLayer } = useStore.getState()
    if (!scene?.tileUrl || !list) {
      removeLayer(TIMELINE_LAYER_ID)
      return
    }
    const r = list.render
    const sensorId = scene.sensor === 'sentinel-2' ? 'sentinel-2-l2a' : scene.sensor === 'landsat' ? 'landsat-c2-l2' : 'sentinel-1-rtc'
    addLayer({
      id: TIMELINE_LAYER_ID,
      name: `${SENSOR_LABEL[scene.sensor]} ${scene.date}`,
      type: 'raster',
      tileUrl: scene.tileUrl,
      visible: true,
      opacity: 1,
      bounds: bbox ?? undefined,
      aoiMask: true,
      raster: {
        kind: r.mode === 'true_colour' ? 'rgb' : 'continuous',
        sensor: sensorId,
        collection: scene.collection,
        sceneId: scene.id,
        datetime: scene.date,
        ...(r.rescale ? { rescale: [r.rescale] } : {}),
        stretch: 'fixed',
        ...(r.colormap ? { colormap: r.colormap } : {}),
        units: r.units,
        ...(r.mode === 'ndvi' ? { index: 'NDVI' } : {}),
      },
      provenance: {
        source: `${list.label} via ${list.provider}`,
        date: scene.date,
        method: `${r.label}${r.rescale ? ` on a fixed range of ${r.rescale[0]} to ${r.rescale[1]} so every frame uses the same colours` : ''}; scene ${scene.id}, shown only inside the drawn area`,
        clip: 'polygon (display mask)',
      },
    })
  }, [scene, list, bbox])

  // Take the layer off the map when the list goes away or the timeline unmounts.
  useEffect(() => () => useStore.getState().removeLayer(TIMELINE_LAYER_ID), [])

  // Warm the tiles of the next frames (and the one before) so stepping and playing do not wait on the network.
  useEffect(() => {
    if (!list || !map || !bbox) return
    const view = map.getBounds()
    const area = { west: Math.max(bbox[0], view.getWest()), south: Math.max(bbox[1], view.getSouth()), east: Math.min(bbox[2], view.getEast()), north: Math.min(bbox[3], view.getNorth()) }
    if (area.west >= area.east || area.south >= area.north) return
    // 256 px tiles are requested one zoom level above the map's
    const tiles = tilesFor(area, Math.floor(map.getZoom()) + 1)
    const ahead = playing ? [1, 2, 3] : [1, -1]
    for (const d of ahead) {
      const s = list.scenes[index + d]
      if (s?.tileUrl) prefetchTiles(s.tileUrl, tiles)
    }
  }, [list, index, map, bbox, playing])
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function usePlayback() {
  const playing = useTimeline((s) => s.playing)
  const speed = useTimeline((s) => s.speed)
  const n = useTimeline((s) => s.list?.scenes.length ?? 0)
  const index = useTimeline((s) => s.index)
  useEffect(() => {
    if (!playing || n === 0) return
    const id = window.setTimeout(function tick() {
      const { index, setIndex, setPlaying } = useTimeline.getState()
      if (index >= n - 1) { setPlaying(false); return }
      setIndex(index + 1)
    }, FRAME_MS / speed)
    return () => window.clearTimeout(id)
  }, [playing, speed, n, index])
}

function togglePlay() {
  const t = useTimeline.getState()
  const n = t.list?.scenes.length ?? 0
  if (n === 0) return
  if (!t.playing && t.index >= n - 1) t.setIndex(0)
  t.setPlaying(!t.playing)
}

// ---------------------------------------------------------------------------
// The archive panel
// ---------------------------------------------------------------------------

function SceneRow({ scene, active, checked, onJump, onToggle }: { scene: SceneRecord; active: boolean; checked: boolean; onJump: () => void; onToggle: () => void }) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <li ref={ref} className={cn('flex items-center gap-2 rounded-md px-1.5 py-1', active && 'bg-accent text-accent-foreground')} aria-current={active ? 'true' : undefined} data-testid="scene-row" data-scene={scene.id}>
      <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Choose the scene of ${dayLabel(scene.date)}`} className="size-4 accent-[var(--teal)]" />
      <button type="button" onClick={onJump} className="grid min-w-0 flex-1 grid-cols-[6.25rem_1fr_auto] items-baseline gap-2 text-left" title={scene.id}>
        <span className="text-body-strong tabular-nums">{dayLabel(scene.date)}</span>
        <span className="truncate text-caption text-muted-foreground">{scene.platform}{scene.relativeOrbit != null ? ` · orbit ${scene.relativeOrbit}` : ''}</span>
        <span className="text-data text-muted-foreground">
          {scene.cloudPct != null ? `${Math.round(scene.cloudPct)}% cloud` : 'radar'}
          {scene.coveragePct < 90 && <span className="ml-1 text-warning" title="This scene covers only part of the area">{Math.round(scene.coveragePct)}% of area</span>}
        </span>
      </button>
    </li>
  )
}

function AnalyseMenu({ scenes }: { scenes: SceneRecord[] }) {
  const [ops, setOps] = useState<OperationInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const { run } = useRunOperation()
  const openToolForScenes = useUi((s) => s.openToolForScenes)
  const setDockTab = useUi((s) => s.setDockTab)
  useEffect(() => {
    if (!open || ops) return
    loadOperations().then(setOps, (e: Error) => setErr(e.message))
  }, [open, ops])

  const pinnable = useMemo(() => (ops ?? []).filter(isDatePinnable).sort((a, b) => a.name.localeCompare(b.name)), [ops])
  const byName = (n: string) => ops?.find((o) => o.name === n)

  /** Queue one job per scene for an operation and fixed extra arguments (the quick actions). */
  const quick = async (name: string, extra: Record<string, unknown>, title: string) => {
    const op = byName(name)
    if (!op) return
    const plan = planPins(op, scenes, title)
    if (plan.problems.length) return void toast.error(`${title} was not queued`, { description: plan.problems[0] })
    setOpen(false)
    let queued = 0
    for (const r of plan.runs) if (await run(name, { ...extra, ...r.args }, r.label)) queued++
    if (queued) setDockTab('jobs')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={BTN_SM} disabled={scenes.length === 0} data-testid="scene-analyse"><FlaskConical aria-hidden />Analyse</button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="max-h-[22rem] w-[19rem] overflow-y-auto p-1.5">
        <p className="px-1.5 pb-1 pt-0.5 text-muted-foreground text-label">On exactly {scenes.length === 1 ? 'this scene' : `these ${scenes.length} scenes`}</p>
        {err && <p className="px-2 py-1.5 text-caption text-danger">The operation list could not be read: {err}</p>}
        {!ops && !err && <p className="px-2 py-1.5 text-caption text-muted-foreground">Reading the operations...</p>}
        {ops && (
          <>
            <button type="button" className="menu-item" onClick={() => void quick('fetch_ndvi', {}, 'NDVI')} data-testid="analyse-ndvi">NDVI map and mean<span className="ml-auto text-caption text-muted-foreground">Sentinel-2</span></button>
            <button type="button" className="menu-item" onClick={() => void quick('fetch_ndvi', { product: 'imagery' }, 'True colour')}>True colour<span className="ml-auto text-caption text-muted-foreground">Sentinel-2</span></button>
            <p className="px-1.5 pb-1 pt-2 text-muted-foreground text-label">Any dated operation</p>
            {pinnable.map((op) => {
              const plan = planPins(op, scenes, humanName(op.name))
              const reason = plan.problems[0]
              return (
                <button key={op.name} type="button" className="menu-item" disabled={!!reason} title={reason}
                  onClick={() => { setOpen(false); openToolForScenes(op.name, scenes) }} data-testid={`analyse-${op.name}`}>
                  {humanName(op.name)}
                  <span className="ml-auto truncate text-caption text-muted-foreground">{reason ? 'not for these scenes' : plan.runs.length > 1 ? `${plan.runs.length} runs` : ''}</span>
                </button>
              )
            })}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function SeriesPane({ sensor }: { sensor: SceneSensor }) {
  const series = useTimeline((s) => s.series)
  const setSeries = useTimeline((s) => s.setSeries)
  const list = useTimeline((s) => s.list)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const batch = useJobs((s) => s.batches.find((b) => b.id === batchId))
  const { run, submitting } = useRunOperation()
  const handled = useRef<string | null>(null)

  // The finished job's stored result carries the chart; its rows carry the scene each point is.
  useEffect(() => {
    if (!batch || batch.state !== 'finished' || handled.current === batch.id) return
    const job = batch.jobs?.[0]
    if (!job?.resultId) return
    handled.current = batch.id
    const resultId = job.resultId
    void (async () => {
      try {
        const res = await fetch(`/api/results/${encodeURIComponent(resultId)}`, { headers: { 'x-owner-token': (await import('@/lib/projects')).getOwnerToken() } })
        const body = await res.json()
        const result = body.result
        const chart = result?.charts?.[0]
        const rows = chart?.spec?.data?.values as SeriesRow[] | undefined
        if (chart && rows?.length) {
          setSeries({ title: chart.title, rows, spec: chart.spec, resultId })
          setMessage(null)
        } else setMessage(String(result?.summary ?? 'The run gave no chart.').replace(/[*_`]/g, '').slice(0, 280))
      } catch (e) {
        setMessage(e instanceof Error ? e.message : 'The result could not be read.')
      }
    })()
  }, [batch, setSeries])

  const start = async () => {
    const t = useTimeline.getState()
    const chosen = t.selected
    const args: Record<string, unknown> = { sensor, index: 'NDVI' }
    if (chosen.length >= 2) args.scene_ids = chosen
    else {
      if (t.choice.from) args.start = t.choice.from
      if (t.choice.to) args.end = t.choice.to
      args.max_cloud = t.choice.maxCloud < 100 ? t.choice.maxCloud : 60
    }
    setMessage(null)
    setSeries(null)
    const id = await run('scene_series', args, `NDVI over ${SENSOR_LABEL[sensor]} archive`)
    if (id) setBatchId(id)
  }

  const running = submitting || (!!batch && batch.state === 'active')
  const jump = useCallback((d: Record<string, unknown>) => {
    const { list: l, setIndex, setPlaying } = useTimeline.getState()
    if (!l) return
    let i = l.scenes.findIndex((s) => s.id === d.scene_id || s.itemIds.includes(String(d.scene_id)))
    if (i < 0 && typeof d.date === 'string') i = nearestSceneIndex(l.scenes, String(d.date).slice(0, 10))
    if (i < 0) return
    setPlaying(false)
    setIndex(i)
    const box = geometryBbox(useStore.getState().aoi?.geometry)
    if (box) useStore.getState().setFitBoundsTarget(box)
  }, [])

  return (
    <div className="grid gap-1.5 border-t border-border pt-2" data-testid="scene-series">
      <div className="flex items-center justify-between gap-2">
        <span className={OVERLINE}>NDVI over the archive</span>
        <button type="button" className={BTN_SM} onClick={() => void start()} disabled={running || !list || sensor === 'sentinel-1'} data-testid="scene-series-run" title={sensor === 'sentinel-1' ? 'Radar has no NDVI' : 'Reads each scene over the drawn area on the job queue'}>
          {running ? <Loader2 className="animate-spin" aria-hidden /> : <BarChart3 aria-hidden />}Plot
        </button>
      </div>
      {running && <p className="text-caption text-muted-foreground" role="status">Reading scenes on the job queue. Follow it on the Jobs tab.</p>}
      {message && <p className="text-caption text-warning" role="status">{message}</p>}
      {!series && !running && !message && <p className="text-caption text-muted-foreground">{useTimeline.getState().selected.length >= 2 ? 'Plots the scenes you chose.' : 'Plots up to 60 clear scenes of the window, oldest to newest. Click a point to open its scene.'}</p>}
      {series && (
        <>
          <VegaChart spec={series.spec} height={150} onPointClick={jump} />
          <p className="text-caption text-muted-foreground">{series.rows.length} cloud-masked values. Click a point to open its scene.</p>
        </>
      )}
    </div>
  )
}

function ArchivePanel({ onClose }: { onClose: () => void }) {
  const choice = useTimeline((s) => s.choice)
  const setChoice = useTimeline((s) => s.setChoice)
  const list = useTimeline((s) => s.list)
  const status = useTimeline((s) => s.status)
  const error = useTimeline((s) => s.error)
  const progress = useTimeline((s) => s.progress)
  const index = useTimeline((s) => s.index)
  const setIndex = useTimeline((s) => s.setIndex)
  const selected = useTimeline((s) => s.selected)
  const toggleSelected = useTimeline((s) => s.toggleSelected)
  const setSelected = useTimeline((s) => s.setSelected)
  const setCompare = useTimeline((s) => s.setCompare)
  const setMapView = useUi((s) => s.setMapView)
  const aoi = useStore((s) => s.aoi)
  const bbox = useMemo(() => geometryBbox(aoi?.geometry), [aoi])
  const chosen = useMemo(() => (list ? selected.map((id) => list.scenes.find((s) => s.id === id)).filter((s): s is SceneRecord => !!s) : []), [list, selected])

  const reload = useCallback(() => { if (bbox) void useTimeline.getState().load(bbox) }, [bbox])
  // The list follows the choices and the drawn area; a short wait lets a typed date settle.
  const key = loadKey(bbox, choice)
  useEffect(() => {
    if (!bbox) return
    if (useTimeline.getState().loadedKey === key) return // reopened: the list is already for these choices
    const id = window.setTimeout(reload, 350)
    return () => window.clearTimeout(id)
  }, [key])

  const compare = () => {
    if (chosen.length !== 2) return
    const [a, b] = [...chosen].sort((x, y) => x.datetime.localeCompare(y.datetime))
    setCompare({ a: a.id, b: b.id })
    setMapView('compare')
    onClose() // the swipe view needs the whole map
  }
  const isRadar = choice.sensor === 'sentinel-1'

  return (
    <section aria-label="Imagery archive" className="glass flex max-h-full min-h-0 w-[min(25rem,100%)] flex-col gap-2.5 overflow-y-auto rounded-lg p-3" data-testid="archive-panel">
      <header className="flex items-center justify-between gap-2">
        <div>
          <span className={OVERLINE}>Imagery archive</span>
          <h2 className="font-heading text-title text-foreground">Scenes over the drawn area</h2>
        </div>
        <button type="button" className={ICON_BTN_SM} onClick={onClose} aria-label="Close the archive panel"><X aria-hidden /></button>
      </header>

      <div className="grid gap-2">
        <Segmented<SceneSensor> label="Sensor" size="sm" value={choice.sensor} onChange={(v) => setChoice({ sensor: v })} options={SENSORS.map((s) => ({ value: s.value, label: s.label }))} className="w-full [&>button]:flex-1" />
        <Segmented<SceneRender> label="Drawn as" size="sm" value={isRadar ? 'true_colour' : choice.render} onChange={(v) => setChoice({ render: v })}
          options={[{ value: 'true_colour', label: isRadar ? 'VV backscatter (dB)' : 'True colour', disabled: false }, { value: 'ndvi', label: 'NDVI', disabled: isRadar }]} className="w-full [&>button]:flex-1" />
        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <label className="grid gap-1 text-caption text-ink-2">From
            <input type="date" className="field field-sm" value={choice.from} min="1982-01-01" max={choice.to || undefined} onChange={(e) => setChoice({ from: e.target.value })} aria-label="From date, empty for the start of the archive" data-testid="archive-from" />
          </label>
          <label className="grid gap-1 text-caption text-ink-2">To
            <input type="date" className="field field-sm" value={choice.to} min={choice.from || undefined} onChange={(e) => setChoice({ to: e.target.value })} aria-label="To date, empty for today" data-testid="archive-to" />
          </label>
          <label className="grid gap-1 text-caption text-ink-2">Scene cloud
            <select className="field field-sm w-auto" value={choice.maxCloud} disabled={isRadar} onChange={(e) => setChoice({ maxCloud: Number(e.target.value) })} aria-label="Highest scene-wide cloud cover" data-testid="archive-cloud">
              {CLOUDS.map((c) => <option key={c} value={c}>{c === 100 ? 'Any' : `up to ${c}%`}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div role="status" aria-live="polite" className="text-caption text-muted-foreground" data-testid="archive-status">
        {!bbox && 'Draw an area first: scenes are listed for the drawn area.'}
        {bbox && status === 'loading' && <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" aria-hidden />Reading the catalogue{progress && progress.total > 0 ? `: ${progress.loaded} of ${progress.total} scenes` : '. The first read of a long archive takes up to a minute; it is kept afterwards.'}</span>}
        {bbox && status === 'error' && (
          <span className="flex items-center justify-between gap-2 text-danger">
            <span>{error}</span>
            <button type="button" className={BTN_SM} onClick={reload}><RotateCw aria-hidden />Retry</button>
          </span>
        )}
        {bbox && status === 'ready' && list && (list.total === 0
          ? 'The catalogue holds no scene over this area for these choices. Widen the dates or the cloud limit.'
          : <>
              <strong className="text-body-strong text-foreground">{list.total} scenes</strong>, {dayLabel(list.first ?? '')} to {dayLabel(list.last ?? '')}, one per day, oldest first. {list.render.label}{list.render.rescale ? `: ${list.render.rescale[0]} to ${list.render.rescale[1]}, the same colours in every frame` : ''}. Cloud is the whole scene&apos;s, not the drawn area&apos;s.
              {list.truncated && <span className="text-warning"> The catalogue search hit its size limit for at least one year, so some scenes of that year are missing.</span>}
            </>)}
      </div>

      {list && list.total > 0 && (
        <>
          <ul className="max-h-[min(17rem,45vh)] min-h-[7rem] shrink-0 overflow-y-auto rounded-md border border-border bg-sunk p-1" aria-label="Scenes, oldest first" data-testid="scene-list">
            {list.scenes.map((s, i) => (
              <SceneRow key={s.id} scene={s} active={i === index} checked={selected.includes(s.id)} onJump={() => { useTimeline.getState().setPlaying(false); setIndex(i) }} onToggle={() => toggleSelected(s.id)} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-caption text-muted-foreground" data-testid="scene-selected">{chosen.length === 0 ? 'Tick scenes to analyse or compare' : `${chosen.length} chosen`}</span>
            <span className="ml-auto" />
            <AnalyseMenu scenes={chosen} />
            <button type="button" className={BTN_SM} onClick={compare} disabled={chosen.length !== 2} title={chosen.length === 2 ? 'Swipe between the two scenes' : 'Choose exactly two scenes'} data-testid="scene-compare"><Columns2 aria-hidden />Compare</button>
            {chosen.length > 0 && <button type="button" className={ICON_BTN_SM} onClick={() => setSelected([])} aria-label="Clear the chosen scenes" title="Clear"><X aria-hidden /></button>}
          </div>
          <SeriesPane sensor={choice.sensor} />
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

function ArchiveBar({ onOpenPanel }: { onOpenPanel: () => void }) {
  const list = useTimeline((s) => s.list)
  const index = useTimeline((s) => s.index)
  const playing = useTimeline((s) => s.playing)
  const speed = useTimeline((s) => s.speed)
  const setSpeed = useTimeline((s) => s.setSpeed)
  const setIndex = useTimeline((s) => s.setIndex)
  const step = useTimeline((s) => s.step)
  const setPlaying = useTimeline((s) => s.setPlaying)
  const scene = list?.scenes[index] ?? null
  const n = list?.scenes.length ?? 0

  // Arrow keys step, Space plays, wherever focus is inside the timeline except in a text field or on the slider, which has its own arrows.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, select, textarea, [role="slider"]')) {
      if (e.key === ' ' && t.closest('[role="slider"]')) { e.preventDefault(); togglePlay() }
      return
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); step(-1) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); step(1) }
    else if (e.key === ' ' && !t.closest('button')) { e.preventDefault(); togglePlay() }
    else if (e.key === 'Home') { e.preventDefault(); setPlaying(false); setIndex(0) }
    else if (e.key === 'End') { e.preventDefault(); setPlaying(false); setIndex(n - 1) }
  }

  return (
    <div
      role="group"
      aria-label="Time navigation"
      aria-keyshortcuts="ArrowLeft ArrowRight Space"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="glass @container pointer-events-auto flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 outline-offset-2"
      data-testid="time-nav"
    >
      <button type="button" onClick={onOpenPanel} className={cn(ICON_BTN_SM, 'shrink-0')} aria-label="Open the imagery archive" title="Imagery archive" data-testid="open-archive"><CalendarRange aria-hidden /></button>
      <span className="min-w-0 max-w-[16rem] shrink @max-[34rem]:hidden">
        <strong className="block text-body-strong text-foreground">Time navigation</strong>
        <small className="block truncate text-data text-muted-foreground" aria-live="polite" data-testid="scene-caption" title="Cloud is the whole scene's, from the catalogue">{scene ? sceneCaption(scene) : ''}</small>
      </span>
      <button type="button" onClick={() => { setPlaying(false); step(-1) }} className={ICON_BTN_SM} aria-label="Previous scene" disabled={index <= 0}><ChevronLeft aria-hidden /></button>
      <button type="button" onClick={togglePlay} className={ICON_BTN_SM} aria-label={playing ? 'Pause' : 'Play from the oldest scene'} aria-pressed={playing} data-testid="scene-play">{playing ? <Pause aria-hidden /> : <Play aria-hidden />}</button>
      <button type="button" onClick={() => { setPlaying(false); step(1) }} className={ICON_BTN_SM} aria-label="Next scene" disabled={index >= n - 1}><ChevronRight aria-hidden /></button>
      <Slider value={[index]} min={0} max={Math.max(0, n - 1)} step={1} onValueChange={(v) => { setPlaying(false); setIndex(v[0]) }} aria-label="Scene, oldest to newest" className="min-w-[3.75rem] flex-1 [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-range]]:bg-teal [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:border-teal" />
      <span className="shrink-0 text-data text-muted-foreground" data-testid="scene-position">{n === 0 ? '0/0' : `${index + 1}/${n}`}</span>
      <select className="field field-sm w-[4.25rem] shrink-0 @max-[28rem]:hidden" value={speed} onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])} aria-label="Playback speed">
        {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
      </select>
    </div>
  )
}

/** What the map shows: the scene's date and sensor, over the imagery, so a screenshot says what it is. */
function SceneBadge() {
  const scene = useTimeline(currentScene)
  const list = useTimeline((s) => s.list)
  if (!scene || !list) return null
  return (
    <div className="glass pointer-events-none flex items-center gap-2 rounded-md px-2.5 py-1" role="status" data-testid="scene-badge">
      <strong className="text-body-strong text-foreground">{dayLabel(scene.date)}</strong>
      <span className="text-caption text-ink-2">{SENSOR_LABEL[scene.sensor]} {scene.platform !== SENSOR_LABEL[scene.sensor] ? `(${scene.platform})` : ''}</span>
      <span className="badge">{list.render.mode === 'true_colour' ? 'True colour' : list.render.mode === 'ndvi' ? 'NDVI' : 'VV dB'}</span>
    </div>
  )
}

/** The timeline over the map: the bar at the bottom, the archive panel at the top left, the date on the imagery. */
export default function SceneTimeline({ map }: { map: maplibregl.Map | null }) {
  const panelOpen = useTimeline((s) => s.panelOpen)
  const setPanelOpen = useTimeline((s) => s.setPanelOpen)
  const hasList = useTimeline((s) => (s.list?.scenes.length ?? 0) > 0)
  const status = useTimeline((s) => s.status)
  const aoi = useStore((s) => s.aoi)
  useTimelineLayer(map)
  usePlayback()

  // Drawing a new area empties a list that was for the old one; the panel reloads for the new one if it is open.
  const bboxKey = geometryBbox(aoi?.geometry)?.join(',') ?? null
  const listKey = useTimeline((s) => s.listKey)
  useEffect(() => {
    if (listKey && bboxKey !== listKey) useTimeline.getState().reset()
  }, [bboxKey, listKey])

  const showBar = hasList || status === 'loading'
  return (
    <>
      {panelOpen && (
        <div className="absolute bottom-[8rem] left-[4.5rem] top-[4.75rem] z-20 flex w-[min(25rem,calc(100%-6rem))] items-start">
          <ArchivePanel onClose={() => setPanelOpen(false)} />
        </div>
      )}
      <div className="absolute bottom-[1.75rem] left-[18.5rem] right-5 z-10 grid justify-items-start gap-2 max-md:hidden">
        <div className="pointer-events-none"><SceneBadge /></div>
        <div className="w-full max-w-[44rem]">
          {showBar ? <ArchiveBar onOpenPanel={() => setPanelOpen(!panelOpen)} /> : <MapTimelineSlider onBrowse={() => setPanelOpen(true)} />}
        </div>
      </div>
    </>
  )
}
