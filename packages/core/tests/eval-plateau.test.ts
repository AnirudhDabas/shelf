import { describe, expect, it } from 'vitest'
import { computePlateau } from '../src/eval/plateau.js'
import type { ExperimentLog, Verdict } from '../src/logger/jsonl.js'
import type { Hypothesis } from '../src/hypothesis/types.js'

function stub(iter: number, scoreBefore: number, scoreAfter: number, verdict: Verdict = 'kept'): ExperimentLog {
  const hypothesis: Hypothesis = {
    id: `h-${iter}`,
    type: 'title_rewrite',
    productId: 'p',
    productTitle: 'p',
    field: 'title',
    before: '',
    after: '',
    description: '',
    reasoning: '',
    queryFailurePatterns: [],
    predictedEffect: '',
    riskLevel: 'low',
    confidence: 'low',
    estimatedImpact: '',
    promptVersion: 'hypothesis.v1',
  }
  return {
    id: `log-${iter}`,
    iteration: iter,
    timestamp: new Date(2026, 0, iter).toISOString(),
    hypothesis,
    verdict,
    scoreBefore,
    scoreAfter,
    scoreDelta: scoreAfter - scoreBefore,
    confidence: 1,
    confidenceLevel: 'medium',
    durationMs: 100,
    costEstimateUsd: 0.05,
  }
}

describe('computePlateau', () => {
  it('returns an empty report when there are no measured iterations', () => {
    const report = computePlateau([])
    expect(report.series).toEqual([])
    expect(report.plateauIteration).toBeNull()
    expect(report.verdict).toMatch(/nothing to detect/i)
  })

  it('detects no plateau on a steadily climbing trajectory', () => {
    // 10 iterations each adding +2 to the score — well above the 1.0 plateau threshold.
    const logs: ExperimentLog[] = []
    let score = 30
    for (let i = 1; i <= 10; i++) {
      logs.push(stub(i, score, score + 2))
      score += 2
    }
    const report = computePlateau(logs)
    expect(report.plateauIteration).toBeNull()
    expect(report.verdict).toMatch(/no plateau detected/i)
    expect(report.baselineScore).toBe(30)
    expect(report.finalScore).toBe(50)
    expect(report.totalIterations).toBe(10)
  })

  it('detects a plateau after 5 consecutive iterations of near-zero positive deltas', () => {
    // Strong climb for 5 iters, then 7 iters of churn near zero (flat or negative).
    const logs: ExperimentLog[] = []
    let score = 30
    // Big climbs — rolling positive avg stays well above 1.0.
    for (let i = 1; i <= 5; i++) {
      logs.push(stub(i, score, score + 5))
      score += 5
    }
    // Plateau zone — deltas hover around 0, alternating revert and tiny gain.
    for (let i = 6; i <= 12; i++) {
      const delta = i % 2 === 0 ? 0 : -0.5
      const verdict: Verdict = delta > 0 ? 'kept' : 'reverted'
      logs.push(stub(i, score, score + delta, verdict))
      score += delta
    }
    const report = computePlateau(logs)
    expect(report.plateauIteration).not.toBeNull()
    expect(report.plateauIteration).toBeGreaterThanOrEqual(6)
    expect(report.plateauIteration).toBeLessThanOrEqual(12)
    expect(report.verdict).toMatch(/plateaued at iteration/i)
  })

  it('skips checks_failed/generator_failed entries when computing the trajectory', () => {
    const logs: ExperimentLog[] = [
      stub(1, 30, 32, 'kept'),
      stub(2, 32, 32, 'checks_failed'),
      stub(3, 32, 34, 'kept'),
      stub(4, 34, 34, 'generator_failed'),
    ]
    const report = computePlateau(logs)
    expect(report.series).toHaveLength(2)
    expect(report.series[0].iteration).toBe(1)
    expect(report.series[1].iteration).toBe(3)
  })

  it('reports cumulative cost and dollars per score-point gained', () => {
    const logs = [stub(1, 30, 35), stub(2, 35, 40)]
    const report = computePlateau(logs)
    expect(report.cumulativeCostUsd).toBeCloseTo(0.1, 5)
    expect(report.costPerScorePoint).toBeCloseTo(0.1 / 10, 5)
  })

  it('returns null cost-per-point when the loop made no positive progress', () => {
    const logs = [stub(1, 50, 50, 'reverted'), stub(2, 50, 50, 'reverted')]
    const report = computePlateau(logs)
    expect(report.costPerScorePoint).toBeNull()
  })
})
