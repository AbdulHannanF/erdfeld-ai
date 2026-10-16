/** Network crawling primitives for the harvester.
 *
 *  Kept in `src/` (not in the script) so pagination, retry and error isolation
 *  are unit-tested with a mocked HTTP layer. Nothing here knows about the
 *  registry schema: it returns raw catalog JSON plus a failure list.
 */

export interface HttpResponse {
  json: any
  headers: Record<string, string>
}

export type GetJson = (url: string) => Promise<HttpResponse>

export interface CrawlResult<T> {
  items: T[]
  /** Non-fatal problems (a page that failed after retries, a bad child). */
  failures: string[]
}

/** Counting semaphore; one instance bounds total in-flight requests across all sources. */
export class Semaphore {
  private waiting: Array<() => void> = []
  private active = 0
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export interface HttpOptions {
  concurrency?: number
  timeoutMs?: number
  retries?: number
  backoffMs?: number
  userAgent?: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Optional response cache (dev iteration only). */
  cache?: { get(url: string): Promise<HttpResponse | null>; set(url: string, v: HttpResponse): Promise<void> }
}

/** Polite JSON GET: bounded concurrency, timeout, retry with backoff on 429/5xx/network errors. */
export function makeHttp(opts: HttpOptions = {}): GetJson {
  const sem = new Semaphore(Math.min(opts.concurrency ?? 6, 6))
  const timeoutMs = opts.timeoutMs ?? 45_000
  const retries = opts.retries ?? 2
  const backoff = opts.backoffMs ?? 1500
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  return async (url: string) => {
    const cached = await opts.cache?.get(url)
    if (cached) return cached
    const res = await sem.run(async () => {
      let lastErr: unknown
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const r = await doFetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': opts.userAgent ?? 'GeoAgent-registry-harvester/1.0' },
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (r.status === 429 || r.status >= 500) throw new HttpStatusError(r.status, url)
          if (!r.ok) throw new HttpStatusError(r.status, url, false)
          const headers: Record<string, string> = {}
          r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
          return { json: await r.json(), headers }
        } catch (err: any) {
          lastErr = err
          if (err instanceof HttpStatusError && !err.retryable) break
          if (attempt < retries) await sleep(backoff * (attempt + 1))
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    })
    await opts.cache?.set(url, res)
    return res
  }
}

export class HttpStatusError extends Error {
  constructor(readonly status: number, readonly url: string, readonly retryable = true) {
    super(`HTTP ${status} for ${url}`)
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Resolve a possibly relative `next` href against the page it came from. */
function resolveHref(href: string, base: string): string {
  try { return new URL(href, base).toString() } catch { return href }
}

/**
 * Follow STAC `next` links, collecting `pick(json)` from each page.
 * A failing page ends that crawl (reported) but keeps everything already read.
 * Guards: max pages and repeated-URL loops (some servers echo `next` forever).
 */
export async function paginate<T>(
  get: GetJson,
  firstUrl: string,
  pick: (json: any) => T[],
  opts: { maxPages?: number } = {},
): Promise<CrawlResult<T>> {
  const items: T[] = []
  const failures: string[] = []
  const seen = new Set<string>()
  let url: string | null = firstUrl
  let pages = 0
  while (url && pages < (opts.maxPages ?? 500)) {
    if (seen.has(url)) { failures.push(`pagination loop at ${url}`); break }
    seen.add(url)
    try {
      const { json } = await get(url)
      items.push(...pick(json))
      const next: any = (json?.links ?? []).find((l: any) => l?.rel === 'next')
      url = next?.href && (next.method ?? 'GET').toUpperCase() === 'GET' ? resolveHref(next.href, url) : null
      if (next && (next.method ?? 'GET').toUpperCase() !== 'GET') failures.push(`non-GET next link ignored at ${url ?? 'page ' + pages}`)
    } catch (err: any) {
      failures.push(`page ${pages + 1} (${url}): ${err?.message ?? err}`)
      break
    }
    pages++
  }
  if (url && pages >= (opts.maxPages ?? 500)) failures.push(`stopped at max pages (${pages})`)
  return { items, failures }
}

/** All collections of a STAC API (`/collections`, following `next`). */
export function crawlStacCollections(get: GetJson, root: string, pageSize = 100) {
  const sep = root.includes('?') ? '&' : '?'
  return paginate<any>(get, `${root.replace(/\/+$/, '')}/collections${sep}limit=${pageSize}`, (j) =>
    Array.isArray(j?.collections) ? j.collections : [])
}

// ---------------------------------------------------------------------------
// Static STAC trees (Earth Engine)
// ---------------------------------------------------------------------------

/**
 * Walk a static STAC tree from `rootUrl`: catalogs are recursed, collections
 * collected. Child fetches run concurrently (bounded by the shared semaphore in
 * `get`); one broken child is reported and skipped.
 */
export async function crawlStaticTree(get: GetJson, rootUrl: string, maxDepth = 3): Promise<CrawlResult<any>> {
  const items: any[] = []
  const failures: string[] = []
  const seen = new Set<string>()

  async function visit(url: string, depth: number): Promise<void> {
    if (seen.has(url)) return
    seen.add(url)
    let doc: any
    try {
      doc = (await get(url)).json
    } catch (err: any) {
      failures.push(`${url}: ${err?.message ?? err}`)
      return
    }
    if (doc?.type === 'Collection') { items.push(doc); return }
    if (depth >= maxDepth) { failures.push(`max depth at ${url}`); return }
    const children = (doc?.links ?? []).filter((l: any) => l?.rel === 'child' && l?.href).map((l: any) => resolveHref(l.href, url))
    await Promise.all(children.map((c: string) => visit(c, depth + 1)))
  }

  await visit(rootUrl, 0)
  return { items, failures }
}

// ---------------------------------------------------------------------------
// NASA CMR
// ---------------------------------------------------------------------------

const CMR_SEARCH = 'https://cmr.earthdata.nasa.gov/search/collections.json'

/** Provider ids listed as children of the CMR-STAC root. */
export async function cmrStacProviders(get: GetJson, root: string): Promise<string[]> {
  const { json } = await get(root.replace(/\/+$/, '') + '/')
  return (json?.links ?? [])
    .filter((l: any) => l?.rel === 'child' && typeof l?.href === 'string')
    .map((l: any) => String(l.href).replace(/\/+$/, '').split('/').pop() as string)
    .filter((p: string) => p && p !== 'ALL')
}

/**
 * Ids (`<short_name>_<version>`, the CMR-STAC convention) of cloud-hosted
 * collections for one provider, via the CMR search API. Paged by `page_num`.
 */
export async function cmrCloudCollectionIds(get: GetJson, provider: string): Promise<CrawlResult<string>> {
  const items: string[] = []
  const failures: string[] = []
  for (let page = 1; page <= 20; page++) {
    const url = `${CMR_SEARCH}?provider=${encodeURIComponent(provider)}&cloud_hosted=true&page_size=2000&page_num=${page}`
    try {
      const { json } = await get(url)
      const entries: any[] = json?.feed?.entry ?? []
      for (const e of entries) {
        if (e?.short_name && e?.version_id) items.push(`${e.short_name}_${e.version_id}`)
      }
      if (entries.length < 2000) break
    } catch (err: any) {
      failures.push(`cmr search page ${page}: ${err?.message ?? err}`)
      break
    }
  }
  return { items, failures }
}
