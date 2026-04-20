import { FileCache } from '../utils/cache.js'
import type { ShelfConfig } from '../config.js'
import { AnthropicScorer } from './anthropic.js'
import { MockScorer } from './mock.js'
import type { MockContext } from './mock.js'
import { OpenAIScorer } from './openai.js'
import { PerplexityScorer } from './perplexity.js'
import type {
  AggregatedScore,
  ProviderName,
  ScoringProvider,
  ScoringQuery,
  ScoringResult,
} from './types.js'

export * from './types.js'
export { AnthropicScorer, OpenAIScorer, PerplexityScorer, MockScorer }
export type { MockContext }

export interface BuildProvidersOptions {
  cache?: FileCache
  dryRun?: boolean
  mockContext?: MockContext
}

export function buildProviders(
  config: ShelfConfig,
  options: BuildProvidersOptions = {},
): ScoringProvider[] {
  if (options.dryRun) {
    const ctx = options.mockContext ?? { iteration: 0 }
    // Mirror whichever providers are configured; if none are set (common
    // when running dry-run without any API keys), mock all three so the
    // output looks like a full multi-provider run.
    const names: ProviderName[] = []
    if (config.providers.perplexity) names.push('perplexity')
    if (config.providers.openai) names.push('openai')
    if (config.providers.anthropic) names.push('anthropic')
    if (names.length === 0) names.push('perplexity', 'openai', 'anthropic')
    return names.map((n) => new MockScorer(n, ctx))
  }

  const providers: ScoringProvider[] = []
  if (config.providers.perplexity) {
    providers.push(
      new PerplexityScorer({
        apiKey: config.providers.perplexity.apiKey,
        cache: options.cache,
      }),
    )
  }
  if (config.providers.openai) {
    providers.push(
      new OpenAIScorer({
        apiKey: config.providers.openai.apiKey,
        cache: options.cache,
      }),
    )
  }
  if (config.providers.anthropic) {
    providers.push(
      new AnthropicScorer({
        apiKey: config.providers.anthropic.apiKey,
        cache: options.cache,
      }),
    )
  }
  return providers
}

export interface MeasureOptions {
  repetitions?: number
  onResult?: (result: ScoringResult) => void
}

// The AI Shelf Score is the fraction of queries where ANY enabled provider
// returned a citation or mention of the store domain. We repeat each
// (query, provider) pair N times and use a majority vote to smooth over
// the stochasticity of live model calls.
export async function measureScore(
  queries: ScoringQuery[],
  storeDomain: string,
  providers: ScoringProvider[],
  options: MeasureOptions = {},
): Promise<AggregatedScore> {
  const repetitions = options.repetitions ?? 3
  const byProvider: Record<string, { matched: number; total: number }> = {}
  const byQuery: Record<string, boolean> = {}
  let totalCostUsd = 0

  for (const provider of providers) {
    byProvider[provider.name] = { matched: 0, total: 0 }
  }

  for (const query of queries) {
    let queryAppearedAnywhere = false

    for (const provider of providers) {
      let appeared = 0
      for (let i = 0; i < repetitions; i++) {
        const result = await safeScore(provider, query, storeDomain)
        totalCostUsd += result.costUsd
        options.onResult?.(result)
        if (result.appeared) appeared += 1
      }

      const majorityAppeared = appeared > repetitions / 2
      const bucket = byProvider[provider.name]
      if (bucket) {
        bucket.total += 1
        if (majorityAppeared) bucket.matched += 1
      }
      if (majorityAppeared) queryAppearedAnywhere = true
    }

    byQuery[query.id] = queryAppearedAnywhere
  }

  const queriesTotal = queries.length
  const queriesMatched = Object.values(byQuery).filter(Boolean).length
  const overall = queriesTotal === 0 ? 0 : (queriesMatched / queriesTotal) * 100

  const providerScores: Record<string, number> = {}
  for (const [name, bucket] of Object.entries(byProvider)) {
    providerScores[name] = bucket.total === 0 ? 0 : (bucket.matched / bucket.total) * 100
  }

  return {
    overall,
    byProvider: providerScores,
    byQuery,
    queriesTotal,
    queriesMatched,
    measuredAt: new Date().toISOString(),
    totalCostUsd,
  }
}

async function safeScore(
  provider: ScoringProvider,
  query: ScoringQuery,
  storeDomain: string,
): Promise<ScoringResult> {
  try {
    return await provider.score(query, storeDomain)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      queryId: query.id,
      provider: provider.name as ProviderName,
      appeared: false,
      latencyMs: 0,
      costUsd: 0,
      timestamp: new Date().toISOString(),
      error: message,
    }
  }
}
