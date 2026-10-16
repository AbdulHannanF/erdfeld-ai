import { describe, expect, it } from 'vitest'

import { assertProductionConfig, productionConfigProblems } from '../prod-checks'

const prod = { NODE_ENV: 'production', EVIDENCE_SIGNING_KEY: 'k' }

describe('productionConfigProblems', () => {
  it('checks nothing outside production', () => {
    expect(productionConfigProblems({ NODE_ENV: 'development', AGENT_ALLOW_STUB: '1' })).toEqual({ fatal: [], errors: [] })
    expect(productionConfigProblems({})).toEqual({ fatal: [], errors: [] })
  })
  it('is clean for a configured production server', () => {
    expect(productionConfigProblems(prod)).toEqual({ fatal: [], errors: [] })
  })
  it('makes AGENT_ALLOW_STUB=1 fatal', () => {
    expect(productionConfigProblems({ ...prod, AGENT_ALLOW_STUB: '1' }).fatal).toHaveLength(1)
    expect(() => assertProductionConfig({ ...prod, AGENT_ALLOW_STUB: '1' })).toThrow(/AGENT_ALLOW_STUB/)
  })
  it('allows the stub in production only with the explicit e2e flag as well', () => {
    const both = { ...prod, AGENT_ALLOW_STUB: '1', E2E_ALLOW_STUB_IN_PRODUCTION: '1' }
    expect(productionConfigProblems(both).fatal).toEqual([])
    expect(assertProductionConfig(both)).toEqual([])
    // the e2e flag alone enables nothing, and any other value is not the flag
    expect(productionConfigProblems({ ...prod, E2E_ALLOW_STUB_IN_PRODUCTION: '1' }).fatal).toEqual([])
    expect(productionConfigProblems({ ...prod, AGENT_ALLOW_STUB: '1', E2E_ALLOW_STUB_IN_PRODUCTION: 'true' }).fatal).toHaveLength(1)
  })
  it('reports a missing signing key as an error, not a crash', () => {
    const errors = assertProductionConfig({ NODE_ENV: 'production' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/EVIDENCE_SIGNING_KEY/)
  })
  it('wants NEXTAUTH_SECRET only when GitHub sign-in is configured', () => {
    expect(productionConfigProblems(prod).errors).toEqual([])
    const gh = { ...prod, GITHUB_ID: 'id', GITHUB_SECRET: 's' }
    expect(productionConfigProblems(gh).errors[0]).toMatch(/NEXTAUTH_SECRET/)
    expect(productionConfigProblems({ ...gh, NEXTAUTH_SECRET: 'x' }).errors).toEqual([])
  })
})
