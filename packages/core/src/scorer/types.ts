export type ProviderName = 'perplexity' | 'openai' | 'anthropic'

export type QueryIntent = 'purchase' | 'compare' | 'research'

export interface ScoringQuery {
  id: string
  text: string
  category: string
  intent: QueryIntent
  targetProductIds?: string[]
}

export interface ScoringResult {
  queryId: string
  provider: ProviderName
  appeared: boolean
  position?: number
  rawSnippet?: string
  latencyMs: number
  tokensUsed?: number
  costUsd: number
  timestamp: string
  error?: string
}

export interface AggregatedScore {
  overall: number
  byProvider: Record<string, number>
  byQuery: Record<string, boolean>
  queriesTotal: number
  queriesMatched: number
  measuredAt: string
  totalCostUsd: number
}

export interface ScoringProvider {
  name: ProviderName
  score(query: ScoringQuery, storeDomain: string): Promise<ScoringResult>
}
