import type { ExperimentLog } from '../logger/jsonl.js'
import type { PlateauPoint, PlateauReport } from './types.js'

const ROLLING_WINDOW = 5
const PLATEAU_THRESHOLD = 1.0
const PLATEAU_RUN = 5

// Estimate per-iteration cost when shelf.jsonl entries lack costEstimateUsd.
// Roughly $0.08 per iteration matches the dry-run stand-in and a typical
// 50q × 3p × 3r live measurement.
const FALLBACK_COST_PER_ITER = 0.08

function isKeptOrReverted(v: ExperimentLog['verdict']): boolean {
  return v === 'kept' || v === 'kept_uncertain' || v === 'reverted'
}

export function computePlateau(logs: ExperimentLog[]): PlateauReport {
  // Only iterations that produced a real measurement contribute to the
  // trajectory. Failures (generator/apply/measure_failed, checks_failed)
  // carry scoreBefore == scoreAfter and would flatten the rolling average
  // artificially.
  const measured = logs
    .filter((l) => isKeptOrReverted(l.verdict))
    .sort((a, b) => a.iteration - b.iteration)

  if (measured.length === 0) {
    return {
      series: [],
      baselineScore: 0,
      finalScore: 0,
      totalIterations: 0,
      plateauIteration: null,
      plateauScore: null,
      cumulativeCostUsd: 0,
      costPerScorePoint: null,
      verdict: 'No measured iterations in shelf.jsonl — nothing to detect a plateau on.',
    }
  }

  const baselineScore = measured[0].scoreBefore
  const finalScore = measured[measured.length - 1].scoreAfter
  const totalIterations = measured[measured.length - 1].iteration

  const series: PlateauPoint[] = []
  let plateauIteration: number | null = null
  let plateauScore: number | null = null

  for (let i = 0; i < measured.length; i++) {
    const log = measured[i]
    const window = measured.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1)
    const positiveDeltas = window.map((w) => Math.max(0, w.scoreDelta))
    const rollingPositiveAvg =
      positiveDeltas.reduce((s, v) => s + v, 0) / positiveDeltas.length

    series.push({
      iteration: log.iteration,
      score: log.scoreAfter,
      delta: log.scoreDelta,
      rollingPositiveAvg,
    })

    // Trigger: the last PLATEAU_RUN iterations all individually produced a
    // positive delta below the threshold. Using individual deltas (not the
    // rolling average) keeps the trigger from being polluted by a strong
    // climb that hasn't fully aged out of the rolling window yet.
    if (i >= PLATEAU_RUN - 1 && plateauIteration === null) {
      const tail = measured.slice(i - PLATEAU_RUN + 1, i + 1)
      const allBelow = tail.every((w) => Math.max(0, w.scoreDelta) < PLATEAU_THRESHOLD)
      if (allBelow) {
        plateauIteration = tail[0].iteration
        plateauScore = tail[0].scoreAfter
      }
    }
  }

  const cumulativeCostUsd = logs.reduce((sum, l) => {
    const c = Number.isFinite(l.costEstimateUsd) ? l.costEstimateUsd : 0
    return sum + c
  }, 0)
  const reportedCost = cumulativeCostUsd > 0 ? cumulativeCostUsd : logs.length * FALLBACK_COST_PER_ITER
  const scoreGained = finalScore - baselineScore
  const costPerScorePoint = scoreGained > 0 ? reportedCost / scoreGained : null

  let verdict: string
  if (plateauIteration !== null) {
    verdict = `Score plateaued at iteration ${plateauIteration} (score: ${plateauScore?.toFixed(1) ?? '?'}). Further iterations produced diminishing returns.`
  } else {
    verdict = `No plateau detected — the loop is still finding improvements after ${totalIterations} iterations.`
  }

  return {
    series,
    baselineScore,
    finalScore,
    totalIterations,
    plateauIteration,
    plateauScore,
    cumulativeCostUsd: reportedCost,
    costPerScorePoint,
    verdict,
  }
}
