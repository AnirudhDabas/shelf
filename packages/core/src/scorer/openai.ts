import OpenAI from 'openai'
import { retry } from '../utils/retry.js'
import { FileCache, cacheKey } from '../utils/cache.js'
import { estimateCost } from '../utils/cost.js'
import { detectDomainAppearance } from './detect.js'
import { createResponse } from './openai-responses.js'
import type { ScoringProvider, ScoringQuery, ScoringResult } from './types.js'

const MODEL = 'gpt-4o-mini'
const TIMEOUT_MS = 30_000

interface ResponsesOutputAnnotation {
  type: string
  url?: string
  title?: string
}

interface ResponsesOutputContent {
  type: string
  text?: string
  annotations?: ResponsesOutputAnnotation[]
}

interface ResponsesOutputItem {
  type: string
  content?: ResponsesOutputContent[]
  // web_search_call items include a sources array in some API versions
  sources?: Array<{ url?: string }>
}

interface ResponsesApiResponse {
  id: string
  output?: ResponsesOutputItem[]
  output_text?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface OpenAIProviderOptions {
  apiKey: string
  cache?: FileCache
}

export class OpenAIScorer implements ScoringProvider {
  readonly name = 'openai' as const
  private client: OpenAI
  private cache?: FileCache

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey })
    this.cache = options.cache
  }

  async score(query: ScoringQuery, storeDomain: string): Promise<ScoringResult> {
    const start = Date.now()
    const day = new Date().toISOString().slice(0, 10)
    const key = cacheKey('openai', MODEL, query.text, storeDomain, day)

    const cached = this.cache?.get<ScoringResult>(key)
    if (cached) return cached

    const response = (await retry(
      () =>
        createResponse(
          this.client,
          {
            model: MODEL,
            tools: [{ type: 'web_search' }],
            input: buildPrompt(query.text),
          },
          { timeout: TIMEOUT_MS },
        ),
      { attempts: 3, baseDelayMs: 1000 },
    )) as unknown as ResponsesApiResponse

    const { text, urls } = extractTextAndUrls(response)
    const detection = detectDomainAppearance(storeDomain, text, urls)
    const usage = response.usage ?? {}
    const tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    const costUsd = estimateCost('openai:gpt-4o-mini', {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    })

    const result: ScoringResult = {
      queryId: query.id,
      provider: 'openai',
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
  return `I'm shopping for: ${queryText}. What specific products would you recommend? Include direct links to where I can buy them.`
}

function extractTextAndUrls(response: ResponsesApiResponse): { text: string; urls: string[] } {
  const urls: string[] = []
  const texts: string[] = []

  if (response.output_text) texts.push(response.output_text)

  for (const item of response.output ?? []) {
    if (item.type === 'web_search_call' && Array.isArray(item.sources)) {
      for (const source of item.sources) {
        if (source.url) urls.push(source.url)
      }
    }
    if (item.content) {
      for (const content of item.content) {
        if (content.type === 'output_text' && content.text) texts.push(content.text)
        for (const ann of content.annotations ?? []) {
          if (ann.type === 'url_citation' && ann.url) urls.push(ann.url)
        }
      }
    }
  }

  return { text: texts.join('\n'), urls }
}
