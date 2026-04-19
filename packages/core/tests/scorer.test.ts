import { describe, expect, it } from 'vitest'
import { measureScore } from '../src/scorer/index.js'
import type {
  ProviderName,
  ScoringProvider,
  ScoringQuery,
  ScoringResult,
} from '../src/scorer/types.js'

function makeQuery(id: string, extra: Partial<ScoringQuery> = {}): ScoringQuery {
  return {
    id,
    text: `query ${id}`,
    category: 'apparel',
    intent: 'purchase',
    targetProductIds: [],
    ...extra,
  }
}

class ScriptedProvider implements ScoringProvider {
  name: ProviderName
  private queue: boolean[]
  constructor(name: ProviderName, queue: boolean[]) {
    this.name = name
    this.queue = [...queue]
  }
  async score(query: ScoringQuery): Promise<ScoringResult> {
    const appeared = this.queue.shift() ?? false
    return {
      queryId: query.id,
      provider: this.name,
      appeared,
      latencyMs: 1,
      costUsd: 0.001,
      timestamp: new Date().toISOString(),
    }
  }
}

describe('measureScore', () => {
  it('counts a query as appeared when the provider returns true in 2 of 3 runs (majority)', async () => {
    const provider = new ScriptedProvider('anthropic', [true, true, false])
    const result = await measureScore([makeQuery('q1')], 'example.myshopify.com', [provider], {
      repetitions: 3,
    })
    expect(result.queriesMatched).toBe(1)
    expect(result.queriesTotal).toBe(1)
    expect(result.overall).toBe(100)
    expect(result.byQuery['q1']).toBe(true)
  })

  it('counts a query as NOT appeared when the provider returns true in 1 of 3 runs (minority)', async () => {
    const provider = new ScriptedProvider('anthropic', [true, false, false])
    const result = await measureScore([makeQuery('q1')], 'example.myshopify.com', [provider], {
      repetitions: 3,
    })
    expect(result.queriesMatched).toBe(0)
    expect(result.overall).toBe(0)
    expect(result.byQuery['q1']).toBe(false)
  })

  it('computes overall score as matched/total * 100 across multiple queries', async () => {
    const provider = new ScriptedProvider('anthropic', [
      true, true, true,    // q1: appeared
      false, false, false, // q2: not appeared
      true, true, false,   // q3: appeared
      false, false, false, // q4: not appeared
    ])
    const queries = [makeQuery('q1'), makeQuery('q2'), makeQuery('q3'), makeQuery('q4')]
    const result = await measureScore(queries, 'example.myshopify.com', [provider], {
      repetitions: 3,
    })
    expect(result.queriesMatched).toBe(2)
    expect(result.queriesTotal).toBe(4)
    expect(result.overall).toBe(50)
  })

  it('treats any provider matching as a query appearance (union across providers)', async () => {
    const perplexity = new ScriptedProvider('perplexity', [false, false, false])
    const openai = new ScriptedProvider('openai', [true, true, true])
    const result = await measureScore([makeQuery('q1')], 'example.myshopify.com', [perplexity, openai], {
      repetitions: 3,
    })
    expect(result.byQuery['q1']).toBe(true)
    expect(result.byProvider['perplexity']).toBe(0)
    expect(result.byProvider['openai']).toBe(100)
  })

  it('catches provider errors and records them as non-appearance without throwing', async () => {
    const failing: ScoringProvider = {
      name: 'openai',
      async score() {
        throw new Error('network blew up')
      },
    }
    const result = await measureScore([makeQuery('q1')], 'example.myshopify.com', [failing], {
      repetitions: 2,
    })
    expect(result.overall).toBe(0)
    expect(result.queriesMatched).toBe(0)
  })

  it('accumulates cost across all provider calls', async () => {
    const provider = new ScriptedProvider('anthropic', [true, false, true, false])
    await measureScore([makeQuery('q1'), makeQuery('q2')], 'example.myshopify.com', [provider], {
      repetitions: 2,
    })
    const second = new ScriptedProvider('anthropic', [true, false, true, false])
    const result = await measureScore(
      [makeQuery('q1'), makeQuery('q2')],
      'example.myshopify.com',
      [second],
      { repetitions: 2 },
    )
    expect(result.totalCostUsd).toBeCloseTo(0.004, 5)
  })
})
