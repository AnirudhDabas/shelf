export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'noise'

export interface ConfidenceResult {
  level: ConfidenceLevel
  score: number
  mad: number
  sampleSize: number
  noiseFloor: number
}

// 1.4826 makes MAD a consistent estimator of standard deviation for a
// normally distributed variable. Multiplying MAD by this constant yields
// the noise floor we compare |delta| against.
const CONSISTENCY_CONSTANT = 1.4826
const MIN_SAMPLES = 3

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

export function medianAbsoluteDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const m = median(values)
  return median(values.map((v) => Math.abs(v - m)))
}

export function computeConfidence(
  delta: number,
  historicalDeltas: number[],
): ConfidenceResult {
  const sampleSize = historicalDeltas.length

  if (sampleSize < MIN_SAMPLES) {
    return { level: 'noise', score: 0, mad: 0, sampleSize, noiseFloor: 0 }
  }

  const mad = medianAbsoluteDeviation(historicalDeltas)
  const noiseFloor = mad * CONSISTENCY_CONSTANT
  const abs = Math.abs(delta)

  // MAD=0 means every historical delta equals the median. In that degenerate
  // case any non-zero delta is a clear signal; a zero delta is pure noise.
  if (noiseFloor === 0) {
    if (abs === 0) {
      return { level: 'noise', score: 0, mad, sampleSize, noiseFloor }
    }
    return {
      level: 'high',
      score: Number.POSITIVE_INFINITY,
      mad,
      sampleSize,
      noiseFloor,
    }
  }

  const score = abs / noiseFloor
  let level: ConfidenceLevel
  if (score > 3.0) level = 'high'
  else if (score > 1.5) level = 'medium'
  else if (score > 0.5) level = 'low'
  else level = 'noise'

  return { level, score, mad, sampleSize, noiseFloor }
}
