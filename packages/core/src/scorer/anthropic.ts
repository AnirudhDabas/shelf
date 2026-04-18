import Anthropic from '@anthropic-ai/sdk'
import { retry } from '../utils/retry.js'
import { FileCache, cacheKey } from '../utils/cache.js'
import { estimateCost } from '../utils/cost.js'
import { detectDomainAppearance } from './detect.js'
import type { ScoringProvider, ScoringQuery, ScoringResult } from './types.js'

const MODEL = 'claude-sonnet-4-6'
const TIMEOUT_MS = 30_000
const WEB_SEARCH_TOOL_NAME = 'web_search'

interface AnthropicCitation {
  type?: string
  url?: string
  title?: string
}

interface AnthropicContentBlock {
  type: string
  text?: string
  citations?: AnthropicCitation[]
  // web_search_tool_result blocks carry content entries with url fields
  content?: Array<{ type?: string; url?: string; title?: string }>
}

interface AnthropicMessageResponse {
  id: string
  content: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface AnthropicProviderOptions {
  apiKey: string
  cache?: FileCache
  dryRun?: boolean
}

export class AnthropicScorer implements ScoringProvider {
  readonly name = 'anthropic' as const
  private client: Anthropic
  private cache?: FileCache
  private dryRun: boolean

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey })
    this.cache = options.cache
    this.dryRun = options.dryRun ?? false
  }

  async score(query: ScoringQuery, storeDomain: string): Promise<ScoringResult> {
    const start = Date.now()
    const day = new Date().toISOString().slice(0, 10)
    const key = cacheKey('anthropic', MODEL, query.text, storeDomain, day)

    const cached = this.cache?.get<ScoringResult>(key)
    if (cached) return cached

    if (this.dryRun) {
      return {
        queryId: query.id,
        provider: 'anthropic',
        appeared: false,
        latencyMs: Date.now() - start,
        costUsd: 0,
        timestamp: new Date().toISOString(),
      }
    }

    const response = await retry(
      () =>
        this.client.messages.create(
          {
            model: MODEL,
            max_tokens: 1024,
            tools: [
              {
                type: 'web_search_20250305',
                name: WEB_SEARCH_TOOL_NAME,
                max_uses: 3,
              },
            ] as unknown as Anthropic.Tool[],
            messages: [
              {
                role: 'user',
                content: buildPrompt(query.text),
              },
            ],
          },
          { timeout: TIMEOUT_MS },
        ) as unknown as Promise<AnthropicMessageResponse>,
      { attempts: 3, baseDelayMs: 1000 },
    )

    const { text, urls } = extractTextAndUrls(response)
    const detection = detectDomainAppearance(storeDomain, text, urls)
    const usage = response.usage ?? {}
    const tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    const costUsd = estimateCost('anthropic:claude-sonnet-4-6', {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    })

    const result: ScoringResult = {
      queryId: query.id,
      provider: 'anthropic',
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
  return `I'm shopping for: ${queryText}. Please search the web and recommend specific products I can buy right now. Include the store URL for each recommendation.`
}

function extractTextAndUrls(response: AnthropicMessageResponse): { text: string; urls: string[] } {
  const urls: string[] = []
  const texts: string[] = []

  for (const block of response.content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text)
      for (const cite of block.citations ?? []) {
        if (cite.url) urls.push(cite.url)
      }
    }
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.url) urls.push(result.url)
      }
    }
  }

  return { text: texts.join('\n'), urls }
}
