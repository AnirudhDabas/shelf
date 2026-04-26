import { describe, expect, it } from 'vitest'
import { computeRewardHacking } from '../src/eval/reward-hacking.js'
import type { ExperimentLog, Verdict } from '../src/logger/jsonl.js'
import type { ApplyResult, FieldChange, Hypothesis } from '../src/hypothesis/types.js'

function makeChange(field: string, newValue: string): FieldChange {
  return { field, oldValue: '', newValue }
}

function makeApplyResult(productId: string, changes: FieldChange[]): ApplyResult {
  return {
    hypothesisId: 'h',
    type: 'title_rewrite',
    productId,
    changes,
    response: null,
    appliedAt: new Date().toISOString(),
  }
}

function makeLog(
  iter: number,
  productId: string,
  verdict: Verdict,
  changes: FieldChange[],
): ExperimentLog {
  const hypothesis: Hypothesis = {
    id: `h-${iter}`,
    type: 'title_rewrite',
    productId,
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
    scoreBefore: 50,
    scoreAfter: 51,
    scoreDelta: 1,
    confidence: 1,
    confidenceLevel: 'medium',
    durationMs: 100,
    costEstimateUsd: 0.05,
    applyResult: makeApplyResult(productId, changes),
  }
}

describe('computeRewardHacking', () => {
  it('marks the report unavailable when there are no kept experiments', () => {
    const logs = [makeLog(1, 'p1', 'reverted', [makeChange('title', 'short')])]
    const report = computeRewardHacking(logs)
    expect(report.available).toBe(false)
    expect(report.risk).toBe('unknown')
  })

  it('flags rising title length as high risk when the slope is large enough', () => {
    // Titles grow ~4 chars/iter — well above the 0.5 threshold.
    const logs: ExperimentLog[] = []
    for (let i = 1; i <= 8; i++) {
      const title = 'X'.repeat(20 + i * 4)
      logs.push(makeLog(i, `p${i}`, 'kept', [makeChange('title', title)]))
    }
    const report = computeRewardHacking(logs)
    expect(report.titleLengthSlope).toBeGreaterThan(0.5)
    expect(report.signals.some((s) => s.includes('title length growing'))).toBe(true)
    expect(report.risk).not.toBe('low')
  })

  it('flags clustering when most kept changes hit the same product', () => {
    const logs: ExperimentLog[] = []
    for (let i = 1; i <= 6; i++) {
      logs.push(makeLog(i, 'p1', 'kept', [makeChange('title', 'Stable title')]))
    }
    logs.push(makeLog(7, 'p2', 'kept', [makeChange('title', 'Stable title')]))
    const report = computeRewardHacking(logs)
    expect(
      report.signals.some((s) => s.includes('cluster on a single product')),
    ).toBe(true)
  })

  it('returns low risk for a stable, diverse keep stream', () => {
    const logs: ExperimentLog[] = []
    for (let i = 1; i <= 6; i++) {
      logs.push(
        makeLog(i, `p${i}`, 'kept', [makeChange('title', 'Waterproof rain jacket')]),
      )
    }
    const report = computeRewardHacking(logs)
    expect(report.risk).toBe('low')
    expect(report.signals).toEqual([])
  })

  it('detects keyword-density creep across kept descriptions', () => {
    // Each kept description has the word "waterproof" repeated more often.
    const logs: ExperimentLog[] = []
    for (let i = 1; i <= 8; i++) {
      const text = `<p>${'waterproof '.repeat(i)}rain jacket built for outdoor travel and urban commutes.</p>`
      logs.push(
        makeLog(i, `p${i}`, 'kept', [makeChange('descriptionHtml', text)]),
      )
    }
    const report = computeRewardHacking(logs)
    expect(report.keywordDensitySlope).toBeGreaterThan(0)
    expect(
      report.signals.some(
        (s) => s.includes('keyword count') || s.includes('cluster') || s.includes('grade'),
      ),
    ).toBe(true)
    expect(report.risk).not.toBe('low')
  })
})
