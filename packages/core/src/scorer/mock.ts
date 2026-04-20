import type { ProviderName, ScoringProvider, ScoringQuery, ScoringResult } from './types.js'

export interface MockContext {
  // Loop mutates this before each measurement so the mock scorer can
  // return a slowly rising "appeared" probability — simulates a real
  // optimization curve without calling any external API.
  iteration: number
}

const BASE_P = 0.3
const PER_ITER_DRIFT = 0.01
const DRIFT_CAP = 0.4
const JITTER_AMPLITUDE = 0.1

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
    // Seed without provider name — all three mock providers agree on
    // whether a query appeared, so the overall aggregate stays near p
    // instead of ballooning via the OR across providers.
    const roll = seededUnit(`${query.id}|${iter}`)
    const appeared = roll < p
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
