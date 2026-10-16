import { describe, expect, it, vi } from 'vitest'
import { crawlStacCollections, crawlStaticTree, makeHttp, paginate, Semaphore, type GetJson } from '../crawl'

const page = (collections: any[], next?: string) => ({
  json: { collections, links: next ? [{ rel: 'next', href: next, method: 'GET' }] : [] },
  headers: {},
})

describe('paginate', () => {
  it('follows next links and resolves relative hrefs', async () => {
    const pages: Record<string, any> = {
      'https://x.test/stac/collections?limit=100': page([{ id: 'a' }], '/stac/collections?cursor=2'),
      'https://x.test/stac/collections?cursor=2': page([{ id: 'b' }], 'https://x.test/stac/collections?cursor=3'),
      'https://x.test/stac/collections?cursor=3': page([{ id: 'c' }]),
    }
    const get: GetJson = async (u) => pages[u] ?? Promise.reject(new Error('404 ' + u))
    const res = await crawlStacCollections(get, 'https://x.test/stac')
    expect(res.items.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(res.failures).toEqual([])
  })

  it('keeps what it read and reports when a later page fails', async () => {
    const get: GetJson = async (u) => {
      if (u.includes('cursor=2')) throw new Error('boom')
      return page([{ id: 'a' }], 'https://x.test/stac/collections?cursor=2')
    }
    const res = await crawlStacCollections(get, 'https://x.test/stac')
    expect(res.items).toHaveLength(1)
    expect(res.failures[0]).toMatch(/page 2.*boom/)
  })

  it('stops on a next link that loops back', async () => {
    const get: GetJson = async (u) => page([{ id: 'a' }], u)
    const res = await paginate(get, 'https://x.test/c', (j) => j.collections)
    expect(res.items).toHaveLength(1)
    expect(res.failures[0]).toMatch(/loop/)
  })

  it('does not follow POST next links (reports them)', async () => {
    const get: GetJson = async () => ({ json: { collections: [{ id: 'a' }], links: [{ rel: 'next', href: 'https://x.test/n', method: 'POST' }] }, headers: {} })
    const res = await paginate(get, 'https://x.test/c', (j) => j.collections)
    expect(res.items).toHaveLength(1)
    expect(res.failures.join()).toMatch(/non-GET/)
  })
})

describe('crawlStaticTree', () => {
  it('recurses catalogs, collects collections, isolates a broken child', async () => {
    const docs: Record<string, any> = {
      'https://s.test/catalog.json': { type: 'Catalog', links: [{ rel: 'child', href: 'A/catalog.json' }, { rel: 'child', href: 'B/catalog.json' }, { rel: 'root', href: 'catalog.json' }] },
      'https://s.test/A/catalog.json': { type: 'Catalog', links: [{ rel: 'child', href: 'a1.json' }, { rel: 'child', href: 'a2.json' }] },
      'https://s.test/A/a1.json': { type: 'Collection', id: 'A/1' },
      'https://s.test/A/a2.json': { type: 'Collection', id: 'A/2' },
    }
    const get: GetJson = async (u) => {
      if (docs[u]) return { json: docs[u], headers: {} }
      throw new Error('HTTP 404 ' + u)
    }
    const res = await crawlStaticTree(get, 'https://s.test/catalog.json')
    expect(res.items.map((c) => c.id).sort()).toEqual(['A/1', 'A/2'])
    expect(res.failures).toHaveLength(1)
    expect(res.failures[0]).toMatch(/B\/catalog.json/)
  })
})

describe('makeHttp', () => {
  const ok = (body: any) => new Response(JSON.stringify(body), { status: 200 })

  it('retries 5xx and 429 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('x', { status: 503 }))
      .mockResolvedValueOnce(new Response('x', { status: 429 }))
      .mockResolvedValueOnce(ok({ fine: true }))
    const get = makeHttp({ fetchImpl: fetchImpl as any, sleep: async () => {}, retries: 2 })
    expect((await get('https://x.test')).json).toEqual({ fine: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 404 }))
    const get = makeHttp({ fetchImpl: fetchImpl as any, sleep: async () => {} })
    await expect(get('https://x.test')).rejects.toThrow(/404/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never exceeds 6 requests in flight, even if asked for more', async () => {
    let active = 0
    let peak = 0
    const fetchImpl = vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return ok({})
    })
    const get = makeHttp({ fetchImpl: fetchImpl as any, concurrency: 50 })
    await Promise.all(Array.from({ length: 30 }, (_, i) => get(`https://x.test/${i}`)))
    expect(peak).toBeLessThanOrEqual(6)
    expect(fetchImpl).toHaveBeenCalledTimes(30)
  })
})

describe('Semaphore', () => {
  it('releases waiters in order', async () => {
    const s = new Semaphore(1)
    const order: number[] = []
    await Promise.all([1, 2, 3].map((n) => s.run(async () => { await new Promise((r) => setTimeout(r, 2)); order.push(n) })))
    expect(order).toEqual([1, 2, 3])
  })
})
