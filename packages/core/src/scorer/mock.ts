import type { ProviderName, ScoringProvider, ScoringQuery, ScoringResult } from './types.js'

export interface MockContext {
  // Loop mutates this before each measurement so the mock scorer can
  // return a slowly rising "appeared" probability — simulates a real
  // optimization curve without calling any external API.
  iteration: number
}

const BASE_P = 0.3
const PER_ITER_DRIFT = 0.0152
const DRIFT_CAP = 0.4
const JITTER_AMPLITUDE = 0

// Stable per-query ordinal shared across all mock providers and scorings.
// Assigned on first sight so the appeared-count is exactly floor(p * N)
// instead of a binomial draw — gives the demo a smooth, predictable
// 30 → 68 curve over 25 iterations regardless of how queries were generated.
const queryOrdinals = new Map<string, number>()
function ordinalFor(queryId: string): number {
  let ord = queryOrdinals.get(queryId)
  if (ord === undefined) {
    ord = queryOrdinals.size
    queryOrdinals.set(queryId, ord)
  }
  return ord
}

// Cheap 32-bit string hash → [0, 1). Deterministic per (query, iteration)
// so all three mock providers agree on whether a query appeared — keeps
// the aggregated score near the target probability instead of exploding
// via the OR across providers.
function seededUnit(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 0x1_0000_0000
}

export class MockScorer implements ScoringProvider {
  readonly name: ProviderName
  private ctx: MockContext

  constructor(name: ProviderName, ctx: MockContext) {
    this.name = name
    this.ctx = ctx
  }

  async score(query: ScoringQuery, _storeDomain: string): Promise<ScoringResult> {
    const iter = this.ctx.iteration
    const drift = Math.min(DRIFT_CAP, iter * PER_ITER_DRIFT)
    const jitter = (seededUnit(`iter:${iter}`) - 0.5) * 2 * JITTER_AMPLITUDE
    const p = clamp(BASE_P + drift + jitter, 0, 1)
    // Ordinal-based threshold: first-seen ordering assigns each query a
    // stable slot in [0, N). The lowest ⌊p·N⌋ ordinals appear, giving
    // score ≈ p·100 without binomial sampling noise. N hardcoded to
    // MEASUREMENT_QUERY_SAMPLE from loop.ts so the baseline's incremental
    // ordinal assignment still yields the right denominator.
    const ord = ordinalFor(query.id)
    const threshold = (ord + 0.5) / 50
    const appeared = threshold < p
    return {
      queryId: query.id,
      provider: this.name,
      appeared,
      latencyMs: 0,
      costUsd: 0,
      timestamp: new Date().toISOString(),
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
