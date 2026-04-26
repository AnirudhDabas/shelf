import { describe, expect, it } from 'vitest'
import { computeHypothesisEffectiveness } from '../src/eval/hypothesis-effectiveness.js'
import type { ExperimentLog, Verdict } from '../src/logger/jsonl.js'
import type { Hypothesis, HypothesisType } from '../src/hypothesis/types.js'

let counter = 0

function makeHypothesis(type: HypothesisType, productId = 'gid://shopify/Product/1'): Hypothesis {
  counter += 1
  return {
    id: `h-${counter}`,
    type,
    productId,
    productTitle: 'Test product',
    field: type === 'tags_update' ? 'tags' : 'title',
    before: 'old',
    after: 'new',
    description: 'test',
    reasoning: 'test',
    queryFailurePatterns: [],
    predictedEffect: 'test',
    riskLevel: 'low',
    confidence: 'medium',
    estimatedImpact: '+1',
    promptVersion: 'hypothesis.v1',
  }
}

function makeLog(
  iteration: number,
  type: HypothesisType,
  verdict: Verdict,
  scoreDelta: number,
  productId = 'gid://shopify/Product/1',
): ExperimentLog {
  return {
    id: `log-${iteration}`,
    iteration,
    timestamp: new Date(2026, 0, iteration).toISOString(),
    hypothesis: makeHypothesis(type, productId),
    verdict,
    scoreBefore: 50,
    scoreAfter: 50 + scoreDelta,
    scoreDelta,
    confidence: 1,
    confidenceLevel: 'medium',
    durationMs: 100,
    costEstimateUsd: 0.01,
  }
}

describe('computeHypothesisEffectiveness', () => {
  it('returns empty rows when no logs are provided', () => {
    const report = computeHypothesisEffectiveness([])
    expect(report.rows).toEqual([])
    expect(report.priorityOrder).toEqual([])
    expect(report.totalExperiments).toBe(0)
  })

  it('groups experiments by hypothesis type and computes keep rate + avg deltas', () => {
    const logs = [
      makeLog(1, 'title_rewrite', 'kept', 3),
      makeLog(2, 'title_rewrite', 'kept', 5),
      makeLog(3, 'title_rewrite', 'reverted', -2),
      makeLog(4, 'tags_update', 'reverted', -1),
      makeLog(5, 'tags_update', 'reverted', 0),
    ]
    const report = computeHypothesisEffectiveness(logs)
    const titleRow = report.rows.find((r) => r.type === 'title_rewrite')!
    const tagsRow = report.rows.find((r) => r.type === 'tags_update')!
    expect(titleRow.total).toBe(3)
    expect(titleRow.kept).toBe(2)
    expect(titleRow.reverted).toBe(1)
    expect(titleRow.keepRate).toBeCloseTo(2 / 3, 5)
    expect(titleRow.avgScoreDeltaKept).toBe(4)
    expect(titleRow.avgScoreDeltaReverted).toBe(-2)
    expect(tagsRow.kept).toBe(0)
    expect(tagsRow.keepRate).toBe(0)
  })

  it('ranks rows by keep rate descending and breaks ties by avg kept delta', () => {
    const logs = [
      makeLog(1, 'title_rewrite', 'kept', 1),
      makeLog(2, 'title_rewrite', 'kept', 1),
      makeLog(3, 'description_restructure', 'kept', 5),
      makeLog(4, 'description_restructure', 'kept', 5),
      makeLog(5, 'tags_update', 'reverted', 0),
    ]
    const report = computeHypothesisEffectiveness(logs)
    expect(report.rows[0].type).toBe('description_restructure')
    expect(report.rows[1].type).toBe('title_rewrite')
    expect(report.rows[2].type).toBe('tags_update')
  })

  it('counts kept_uncertain as kept and weights expected value accordingly', () => {
    const logs = [
      makeLog(1, 'seo_title', 'kept_uncertain', 2),
      makeLog(2, 'seo_title', 'kept', 4),
      makeLog(3, 'seo_title', 'reverted', 0),
    ]
    const report = computeHypothesisEffectiveness(logs)
    const row = report.rows.find((r) => r.type === 'seo_title')!
    expect(row.kept).toBe(2)
    expect(row.avgScoreDeltaKept).toBe(3)
    expect(row.expectedValuePerAttempt).toBeCloseTo((2 / 3) * 3, 5)
  })

  it('priority order ranks by expected value per attempt, not raw keep rate', () => {
    // metafield_add: 100% keep but +1 each → EV=1
    // title_rewrite: 50% keep but +6 each → EV=3 (better priority)
    const logs = [
      makeLog(1, 'metafield_add', 'kept', 1),
      makeLog(2, 'metafield_add', 'kept', 1),
      makeLog(3, 'title_rewrite', 'kept', 6),
      makeLog(4, 'title_rewrite', 'reverted', -1),
    ]
    const report = computeHypothesisEffectiveness(logs)
    expect(report.priorityOrder[0]).toBe('title_rewrite')
    expect(report.priorityOrder[1]).toBe('metafield_add')
  })

  it('computes median iterations to first keep per product', () => {
    // Product A: tried at iter 1, kept at iter 3 → 3 iters
    // Product B: tried at iter 2, kept at iter 4 → 3 iters
    // Product C: tried at iter 5, kept at iter 5 → 1 iter
    // Median across [3, 3, 1] = 3
    const logs = [
      makeLog(1, 'title_rewrite', 'reverted', 0, 'A'),
      makeLog(2, 'title_rewrite', 'reverted', 0, 'B'),
      makeLog(3, 'title_rewrite', 'kept', 2, 'A'),
      makeLog(4, 'title_rewrite', 'kept', 2, 'B'),
      makeLog(5, 'title_rewrite', 'kept', 2, 'C'),
    ]
    const report = computeHypothesisEffectiveness(logs)
    const row = report.rows.find((r) => r.type === 'title_rewrite')!
    expect(row.medianIterationsToFirstKeep).toBe(3)
  })

  it('totals verdicts and exposes them in byVerdict', () => {
    const logs = [
      makeLog(1, 'title_rewrite', 'kept', 3),
      makeLog(2, 'title_rewrite', 'reverted', -1),
      makeLog(3, 'title_rewrite', 'checks_failed', 0),
      makeLog(4, 'title_rewrite', 'generator_failed', 0),
    ]
    const report = computeHypothesisEffectiveness(logs)
    expect(report.totalKept).toBe(1)
    expect(report.totalReverted).toBe(1)
    expect(report.byVerdict.checks_failed).toBe(1)
    expect(report.byVerdict.generator_failed).toBe(1)
  })
})
