import { describe, expect, it } from 'vitest'

import { dateWindow } from '../grid-source'

describe('scene search window', () => {
  it('is +/- 30 days around the date by default', () => {
    expect(dateWindow('2023-08-01').datetime).toBe('2023-07-02/2023-08-31')
  })

  it('takes scenes on or before the date for the before side, so an event after it cannot be in the scene', () => {
    expect(dateWindow('2023-08-01', { side: 'before' }).datetime).toBe('2023-06-17/2023-08-01')
  })

  it('takes scenes on or after the date for the after side', () => {
    expect(dateWindow('2023-08-31', { side: 'after' }).datetime).toBe('2023-08-31/2023-10-15')
  })
})
