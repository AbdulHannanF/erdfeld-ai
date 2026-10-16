/**
 * Corroboration: reports of an event at this place and time, found by a separate web-grounded
 * model call. Context for the reader, never evidence: nothing in this module touches a posterior.
 *
 * A report is kept only when the web search actually returned a page from the same site
 * (a grounding chunk), so a source the model invented from memory is dropped and counted. Its
 * publication date is the model's reading of the page and is labelled as such; whether the date
 * falls inside the window is computed here.
 */

import type { CorroborationEvent, CorroborationSource } from './events'
import type { InvestigatorLlm, RawReport, ReportSearchInput, ReportSearchResult } from './llm'

const DAY_MS = 86_400_000

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' }
}

const normDomain = (d: string) => d.replace(/^www\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()

/** YYYY-MM-DD for an ISO date or a written one ("August 24, 2025"); null when it does not parse. */
export function isoDate(text: string): string | null {
  const t = text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Number.isFinite(Date.parse(t)) ? t : null
  if (!/\d{4}/.test(t)) return null
  const ms = Date.parse(`${t} UTC`)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null
}

/** Days outside [start, end] (0 inside), or null for a date that does not parse. */
export function daysFromWindow(published: string, window: { start: string; end: string }): number | null {
  const iso = isoDate(published)
  if (!iso) return null
  const t = Date.parse(iso)
  const s = Date.parse(window.start)
  const e = Date.parse(window.end)
  if (t < s) return Math.round((s - t) / DAY_MS)
  if (t > e) return Math.round((t - e) / DAY_MS)
  return 0
}

export interface ClassifyOutcome { sources: CorroborationSource[]; droppedUngrounded: number }

/** Keep the reports a search chunk backs; mark each against the window. Deduplicated by site and title. */
export function classifyReports(result: ReportSearchResult, window: { start: string; end: string }): ClassifyOutcome {
  const chunkDomains = new Map<string, string>()
  const byUri = new Map<string, string>()
  for (const c of result.chunks) {
    const d = normDomain(c.domain || c.title)
    if (d && !chunkDomains.has(d)) chunkDomains.set(d, c.uri)
    if (d) byUri.set(c.uri, d)
  }
  const seen = new Set<string>()
  const sources: CorroborationSource[] = []
  let droppedUngrounded = 0
  for (const r of result.reports as RawReport[]) {
    // The search returns redirect links, so a report is backed either by its exact link or by its site.
    const host = byUri.get(r.url) ?? hostOf(r.url)
    if (!host || !chunkDomains.has(host)) { droppedUngrounded++; continue }
    const key = `${host}|${r.title.trim().toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const gap = daysFromWindow(r.published.trim(), window)
    sources.push({
      title: r.title.trim() || host,
      url: r.url,
      publisher: r.publisher.trim() || host,
      date: gap === null ? '' : isoDate(r.published)!,
      inWindow: gap === 0,
      days_from_window: gap,
    })
  }
  return { sources, droppedUngrounded }
}

/** Search results link through a Google redirect; follow it once (best effort) to show the page's own address. */
export async function resolveRedirect(url: string): Promise<string> {
  if (hostOf(url) !== 'vertexaisearch.cloud.google.com') return url
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
    const loc = res.headers.get('location')
    return loc && /^https?:\/\//.test(loc) ? loc : url
  } catch {
    return url
  }
}

export async function corroborate(llm: InvestigatorLlm, input: ReportSearchInput, resolve: (url: string) => Promise<string> = resolveRedirect): Promise<Omit<CorroborationEvent, 'type'>> {
  const query = `${input.subject} | ${input.place || 'coordinates only'} | ${input.window.start} to ${input.window.end}`
  const base = { role: 'context' as const, query }
  let found: ReportSearchResult
  try {
    found = await llm.searchReports(input)
  } catch (err: any) {
    return { ...base, status: 'failed', sources: [], note: `The web search could not run (${String(err?.message ?? err).slice(0, 160)}). No corroboration was obtained; this says nothing about whether the event was reported.` }
  }
  if (found.chunks.length === 0) {
    return { ...base, status: 'failed', sources: [], note: 'The search returned no grounded pages, so no source could be checked. This is a failure to ground, not evidence that nothing was reported.' }
  }
  const classified = classifyReports(found, input.window)
  const droppedUngrounded = classified.droppedUngrounded
  const sources = await Promise.all(classified.sources.map(async (s) => ({ ...s, url: await resolve(s.url) })))
  const dropped = droppedUngrounded > 0 ? ` ${droppedUngrounded} listed report${droppedUngrounded === 1 ? '' : 's'} had no matching search result and ${droppedUngrounded === 1 ? 'was' : 'were'} dropped.` : ''
  if (sources.length === 0) {
    return { ...base, status: 'no_sources', sources: [], note: `The search ran but returned no report that could be matched to a page it found.${dropped} Absence of reports here is not evidence against the finding.` }
  }
  const dated = sources.filter((s) => s.date !== '').length
  return {
    ...base, status: 'grounded', sources,
    note: `Context only: these reports do not change the finding. Publication dates are the search model's reading of each page (${dated} of ${sources.length} carried one) and are not verified.${dropped}`,
  }
}
