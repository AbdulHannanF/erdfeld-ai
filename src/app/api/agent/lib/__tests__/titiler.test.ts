import { describe, it, expect } from 'vitest'
import { resolveTitilerBase } from '../titiler'

describe('resolveTitilerBase (TITILER_ENDPOINT resolution)', () => {
  it('defaults to the public titiler.xyz when no endpoint is configured', () => {
    expect(resolveTitilerBase(undefined)).toBe('https://titiler.xyz')
    expect(resolveTitilerBase('')).toBe('https://titiler.xyz')
  })

  it('uses a configured self-hosted endpoint verbatim', () => {
    expect(resolveTitilerBase('http://titiler:8000')).toBe('http://titiler:8000')
    expect(resolveTitilerBase('https://tiles.example.com')).toBe('https://tiles.example.com')
  })

  it('trims trailing slash(es) so `${BASE}/cog/tiles/...` never doubles up', () => {
    expect(resolveTitilerBase('http://localhost:8000/')).toBe('http://localhost:8000')
    expect(resolveTitilerBase('https://tiles.example.com///')).toBe('https://tiles.example.com')
  })
})
