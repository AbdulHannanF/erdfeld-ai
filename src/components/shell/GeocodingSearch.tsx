'use client'

import { useState, useRef, useEffect, useCallback, useId } from 'react'
import { Search, MapPin, Loader2, X } from 'lucide-react'
import { parseCoordinates } from '@/lib/coordinates'
import { useStore } from '@/store/useStore'
import { cn } from '@/lib/utils'

interface NominatimResult {
  place_id: number
  display_name: string
  lat: string
  lon: string
  type: string
  class: string
}

/** Place or coordinate search over the map (OpenStreetMap Nominatim for places). Choosing a result,
 *  or pressing Enter on a typed coordinate pair, flies the map there. `/` focuses it. */
export default function GeocodingSearch({ className }: { className?: string }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NominatimResult[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listId = useId()

  const setFlyToTarget = useStore((s) => s.setFlyToTarget)

  // The command palette and shortcuts can ask for focus through a custom event.
  useEffect(() => {
    const handler = () => inputRef.current?.focus()
    window.addEventListener('focus-geocoding-search', handler)
    return () => window.removeEventListener('focus-geocoding-search', handler)
  }, [])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  // `/` jumps to the search from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const [coordNote, setCoordNote] = useState<string | null>(null)

  const doSearch = useCallback(async (q: string) => {
    // A typed coordinate pair goes straight to the map; an impossible one is explained, not guessed.
    const c = parseCoordinates(q)
    if (c.kind === 'ok') {
      setResults([])
      setFailed(false)
      setCoordNote(null)
      setIsOpen(false)
      setFlyToTarget({ lng: c.lng, lat: c.lat, zoom: 13 })
      return
    }
    if (c.kind === 'invalid') {
      setResults([])
      setFailed(false)
      setCoordNote(c.reason)
      setIsOpen(true)
      return
    }
    setCoordNote(null)
    if (!q.trim()) {
      setResults([])
      setIsOpen(false)
      setFailed(false)
      return
    }
    setIsLoading(true)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
        { signal: controller.signal },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: NominatimResult[] = await res.json()
      setResults(data)
      setFailed(false)
      setIsOpen(true)
    } catch {
      // A failed lookup is not "no such place": say which it was.
      setResults([])
      setFailed(true)
      setIsOpen(true)
    } finally {
      clearTimeout(timeout)
      setIsLoading(false)
    }
  }, [setFlyToTarget])

  const handleInputChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    // a coordinate pair waits for Enter: it is complete only when the person says so
    if (parseCoordinates(value).kind === 'none') debounceRef.current = setTimeout(() => doSearch(value), 500)
    else setIsOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      doSearch(query)
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      inputRef.current?.blur()
    }
  }

  const selectResult = (result: NominatimResult) => {
    setFlyToTarget({ lng: parseFloat(result.lon), lat: parseFloat(result.lat), zoom: 12 })
    setIsOpen(false)
    setQuery(result.display_name.split(',')[0])
  }

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const truncateName = (name: string, maxLen = 64) => (name.length <= maxLen ? name : name.slice(0, maxLen) + '…')

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0 || failed) setIsOpen(true) }}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-label="Search a place or coordinates"
          aria-keyshortcuts="/"
          placeholder="Search a place or coordinates…"
          data-testid="place-search"
          className="field glass h-10 pl-9 pr-16"
        />
        {!query && <kbd className="pointer-events-none absolute right-2.5 grid h-5 min-w-5 place-items-center rounded-sm border border-input text-data text-muted-foreground max-md:hidden" aria-hidden>/</kbd>}
        {isLoading && <Loader2 className="absolute right-10 size-3.5 animate-spin text-muted-foreground" aria-hidden />}
        {!isLoading && query && (
          <button
            type="button"
            onClick={() => { setQuery(''); setResults([]); setIsOpen(false); setFailed(false); setCoordNote(null) }}
            className="btn btn-ghost btn-icon-sm absolute right-2"
            aria-label="Clear search"
          >
            <X aria-hidden />
          </button>
        )}
      </div>

      {isOpen && (
        <ul id={listId} className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          {coordNote && <li className="px-3 py-2.5 text-caption text-warning" role="status">{coordNote}</li>}
          {failed && (
            <li className="px-3 py-2.5 text-caption text-warning">The place search could not be reached. Try again in a moment.</li>
          )}
          {!failed && !coordNote && results.length === 0 && (
            <li className="px-3 py-2.5 text-caption text-muted-foreground">No place found for that search.</li>
          )}
          {results.map((result) => (
            <li key={result.place_id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => selectResult(result)}
                className="menu-item"
              >
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-body leading-tight text-foreground">{truncateName(result.display_name)}</span>
                  <span className="mt-0.5 block text-caption capitalize text-muted-foreground">{result.type.replace(/_/g, ' ')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
