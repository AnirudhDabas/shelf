import { describe, expect, it } from 'vitest'
import {
  computeConfidence,
  median,
  medianAbsoluteDeviation,
} from '../src/confidence/mad.js'

describe('median', () => {
  it('returns 0 for empty array', () => {
    expect(median([])).toBe(0)
  })

  it('returns middle element for odd-length', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle elements for even-length', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe('medianAbsoluteDeviation', () => {
  it('returns 0 when all values are identical', () => {
    expect(medianAbsoluteDeviation([5, 5, 5, 5])).toBe(0)
  })

  it('computes MAD for a known series', () => {
    const mad = medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9])
    expect(mad).toBe(1)
  })
})

describe('computeConfidence', () => {
  it('returns noise when fewer than 3 historical samples exist', () => {
    const result = computeConfidence(5, [1, 2])
    expect(result.level).toBe('noise')
    expect(result.sampleSize).toBe(2)
  })

  it('returns noise when delta is zero and all history is zero (MAD=0 degenerate)', () => {
    const result = computeConfidence(0, [0, 0, 0, 0])
    expect(result.level).toBe('noise')
    expect(result.mad).toBe(0)
  })

  it('returns high with infinite score when MAD=0 and delta is non-zero', () => {
    const result = computeConfidence(0.5, [0, 0, 0, 0])
    expect(result.level).toBe('high')
    expect(result.score).toBe(Number.POSITIVE_INFINITY)
  })

  it('classifies a small delta on a noisy history as noise', () => {
    const history = [0.1, -0.2, 0.3, 0.1, -0.1]
    const result = computeConfidence(0.05, history)
    expect(result.level).toBe('noise')
  })

  it('classifies a large delta on a stable history as high', () => {
    const history = [0.1, -0.1, 0.05, -0.05, 0.0]
    const result = computeConfidence(5, history)
    expect(result.level).toBe('high')
    expect(result.score).toBeGreaterThan(3)
  })

  it('places deltas between 1.5 and 3 at medium', () => {
    const history = [0.1, -0.1, 0.05, -0.05, 0.0]
    const mad = medianAbsoluteDeviation(history)
    const noiseFloor = mad * 1.4826
    const delta = noiseFloor * 2
    const result = computeConfidence(delta, history)
    expect(result.level).toBe('medium')
  })

  it('places deltas between 0.5 and 1.5 at low', () => {
    const history = [0.1, -0.1, 0.05, -0.05, 0.0]
    const mad = medianAbsoluteDeviation(history)
    const noiseFloor = mad * 1.4826
    const delta = noiseFloor * 1
    const result = computeConfidence(delta, history)
    expect(result.level).toBe('low')
  })
})
