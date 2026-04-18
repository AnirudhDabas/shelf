import OpenAI from 'openai'
import { retry } from '../utils/retry.js'
import { FileCache, cacheKey } from '../utils/cache.js'
import { estimateCost } from '../utils/cost.js'
import { detectDomainAppearance } from './detect.js'
import type { ScoringProvider, ScoringQuery, ScoringResult } from './types.js'

const MODEL = 'sonar'
const TIMEOUT_MS = 30_000

interface PerplexityResponse {
  id: string
  choices: Array<{ message: { role: string; content: string } }>
  citations?: string[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface PerplexityProviderOptions {
  apiKey: string
  cache?: FileCache
  dryRun?: boolean
}

export class PerplexityScorer implements ScoringProvider {
  readonly name = 'perplexity' as const
  private client: OpenAI
  private cache?: FileCache
  private dryRun: boolean

  constructor(options: PerplexityProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: 'https://api.perplexity.ai',
    })
    this.cache = options.cache
    this.dryRun = options.dryRun ?? false
  }

  async score(query: ScoringQuery, storeDomain: string): Promise<ScoringResult> {
    const start = Date.now()
    const day = new Date().toISOString().slice(0, 10)
    const key = cacheKey('perplexity', MODEL, query.text, storeDomain, day)

    const cached = this.cache?.get<ScoringResult>(key)
    if (cached) return cached

    if (this.dryRun) {
      return buildEmptyResult(query, 'perplexity', start)
    }

    const completion = await retry(
      () =>
        this.client.chat.completions.create(
          {
            model: MODEL,
            max_tokens: 500,
            messages: [
              {
                role: 'system',
                content:
                  'You are a shopping assistant. Recommend specific purchasable products and include the store URLs in citations.',
              },
              { role: 'user', content: buildPrompt(query.text) },
            ],
          },
          { timeout: TIMEOUT_MS },
        ) as unknown as Promise<PerplexityResponse>,
      { attempts: 3, baseDelayMs: 1000 },
    )

    const text = completion.choices[0]?.message?.content ?? ''
    const citations = completion.citations ?? []
    const detection = detectDomainAppearance(storeDomain, text, citations)
    const usage = completion.usage ?? {}
    const tokensUsed = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
    const costUsd = estimateCost('perplexity:sonar', {
      input: usage.prompt_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
    })

    const result: ScoringResult = {
      queryId: query.id,
      provider: 'perplexity',
      appeared: detection.appeared,
      position: detection.position,
      rawSnippet: detection.snippet,
      latencyMs: Date.now() - start,
      tokensUsed,
      costUsd,
      timestamp: new Date().toISOString(),
    }

    this.cache?.set(key, result)
    return result
  }
}

function buildPrompt(queryText: string): string {
  return `I'm shopping for: ${queryText}. What specific products would you recommend? Include the store URL where each product can be purchased.`
}

function buildEmptyResult(
  query: ScoringQuery,
  provider: 'perplexity',
  start: number,
): ScoringResult {
  return {
    queryId: query.id,
    provider,
    appeared: false,
    latencyMs: Date.now() - start,
    costUsd: 0,
    timestamp: new Date().toISOString(),
  }
}
