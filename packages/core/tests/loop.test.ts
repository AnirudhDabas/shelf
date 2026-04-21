import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/checks/backpressure.js', () => ({
  checkHypothesis: () => ({ passed: true, failures: [], warnings: [] }),
}))

import type { ShelfConfig } from '../src/config.js'
import { ShelfEventEmitter } from '../src/events/emitter.js'
import type { HypothesisApplier } from '../src/hypothesis/applier.js'
import type { HypothesisGenerator } from '../src/hypothesis/generator.js'
import type { HypothesisReverter } from '../src/hypothesis/reverter.js'
import type { ApplyResult, Hypothesis, RevertResult } from '../src/hypothesis/types.js'
import { JsonlLogger } from '../src/logger/jsonl.js'
import { runLoop } from '../src/loop.js'
import type {
  ProviderName,
  ScoringProvider,
  ScoringQuery,
  ScoringResult,
} from '../src/scorer/types.js'
import type { ShopifyAdminClient } from '../src/shopify/admin.js'
import type { ShopifyProduct } from '../src/shopify/types.js'
import { FileCache } from '../src/utils/cache.js'

function makeConfig(overrides: Partial<ShelfConfig['loop']> = {}, paths?: ShelfConfig['paths']): ShelfConfig {
  return {
    store: {
      domain: 'example.myshopify.com',
      adminAccessToken: 'admin',
    },
    providers: { anthropic: { apiKey: 'test-anthropic-key' } },
    loop: {
      maxIterations: 5,
      budgetLimitUsd: 10,
      queriesPerMeasurement: 1,
      ...overrides,
    },
    paths: paths ?? { logFile: 'shelf.jsonl', sessionFile: 'shelf.md' },
    dryRun: false,
    noShopify: false,
  }
}

function makeProduct(id = 'gid://shopify/Product/1', title = 'Rain jacket'): ShopifyProduct {
  return {
    id,
    title,
    descriptionHtml: '<p>Waterproof shell for daily use.</p>',
    productType: 'Outerwear',
    vendor: 'TestBrand',
    tags: [],
    seo: { title: null, description: null },
    metafields: [],
    variants: [],
    images: [],
  }
}

function makeQuery(id: string, target: string): ScoringQuery {
  return {
    id,
    text: `looking for a ${id}`,
    category: 'apparel',
    intent: 'purchase',
    targetProductIds: [target],
  }
}

function makeHypothesis(productId: string, productTitle: string, i = 0): Hypothesis {
  return {
    id: `h-${i}`,
    type: 'title_rewrite',
    productId,
    productTitle,
    field: 'title',
    before: productTitle,
    after: `Packable rain jacket ${i}`,
    description: 'lead with category',
    reasoning: 'AI shoppers search by category',
    queryFailurePatterns: [],
    predictedEffect: 'surface more often',
    riskLevel: 'low',
    confidence: 'medium',
    estimatedImpact: '+3',
    promptVersion: 'hypothesis.v1',
  }
}

function tmpPaths(): ShelfConfig['paths'] {
  const dir = mkdtempSync(join(tmpdir(), 'shelf-loop-'))
  return { logFile: join(dir, 'shelf.jsonl'), sessionFile: join(dir, 'shelf.md') }
}

type Phase = 'baseline' | 'afterApply'

interface FakeScorerController {
  phase: Phase
  provider: ScoringProvider
}

function fakeScorer(baselineAppeared: boolean, afterApplyAppeared: boolean): FakeScorerController {
  const controller: FakeScorerController = {
    phase: 'baseline',
    provider: {
      name: 'anthropic' as ProviderName,
      async score(query: ScoringQuery): Promise<ScoringResult> {
        return {
          queryId: query.id,
          provider: 'anthropic',
          appeared: controller.phase === 'baseline' ? baselineAppeared : afterApplyAppeared,
          latencyMs: 1,
          costUsd: 0.001,
          timestamp: new Date().toISOString(),
        }
      },
    },
  }
  return controller
}

function fakeApplier(onApply: () => void): HypothesisApplier {
  return {
    apply: vi.fn(async (h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> => {
      onApply()
      return {
        hypothesisId: h.id,
        type: h.type,
        productId: p.id,
        changes: [{ field: 'title', oldValue: p.title, newValue: h.after }],
        response: null,
        appliedAt: new Date().toISOString(),
      }
    }),
  } as unknown as HypothesisApplier
}

function fakeReverter(revertSpy: (r: ApplyResult) => void): HypothesisReverter {
  return {
    revert: vi.fn(async (r: ApplyResult): Promise<RevertResult> => {
      revertSpy(r)
      return {
        hypothesisId: r.hypothesisId,
        productId: r.productId,
        restoredChanges: r.changes,
        response: null,
        revertedAt: new Date().toISOString(),
      }
    }),
  } as unknown as HypothesisReverter
}

function fakeGenerator(product: ShopifyProduct): HypothesisGenerator {
  let count = 0
  return {
    generate: vi.fn(async () => makeHypothesis(product.id, product.title, count++)),
  } as unknown as HypothesisGenerator
}

const noopAdmin = {} as unknown as ShopifyAdminClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runLoop', () => {
  it('keeps a hypothesis when score improves and records it in the experiment log', async () => {
    const paths = tmpPaths()
    const config = makeConfig({ maxIterations: 3 }, paths)
    const emitter = new ShelfEventEmitter()
    const product = makeProduct()
    const scorer = fakeScorer(false, true)
    const applier = fakeApplier(() => {
      scorer.phase = 'afterApply'
    })
    const reverter = fakeReverter(() => {})

    const final = await runLoop(config, emitter, {
      admin: noopAdmin,
      providers: [scorer.provider],
      generator: fakeGenerator(product),
      applier,
      reverter,
      products: [product],
      queries: [makeQuery('q1', product.id)],
      sleepMs: async () => {},
      propagationDelayMs: 0,
      cache: new FileCache(mkdtempSync(join(tmpdir(), 'shelf-cache-'))),
    })

    expect(applier.apply).toHaveBeenCalledTimes(1)
    expect(reverter.revert).not.toHaveBeenCalled()
    expect(final.currentScore).toBeGreaterThan(final.baselineScore)

    const logger = new JsonlLogger(paths.logFile)
    const logs = logger.readAll()
    expect(logs.length).toBeGreaterThan(0)
    const kept = logs.find((l) => l.verdict === 'kept' || l.verdict === 'kept_uncertain')
    expect(kept).toBeDefined()
    expect(kept?.scoreAfter).toBeGreaterThan(kept!.scoreBefore)
  })

  it('reverts a hypothesis when score drops and calls reverter.revert with the apply result', async () => {
    const paths = tmpPaths()
    const config = makeConfig({ maxIterations: 1 }, paths)
    const emitter = new ShelfEventEmitter()
    const product = makeProduct()

    // baseline: q1 passes, q2 fails → score 50 (below 90 ceiling, so loop runs)
    // after apply: both fail → score 0 → reverted
    let phase: Phase = 'baseline'
    const provider: ScoringProvider = {
      name: 'anthropic',
      async score(q: ScoringQuery): Promise<ScoringResult> {
        const appeared = phase === 'baseline' && q.id === 'q1'
        return {
          queryId: q.id,
          provider: 'anthropic',
          appeared,
          latencyMs: 1,
          costUsd: 0.001,
          timestamp: new Date().toISOString(),
        }
      },
    }
    const applier = fakeApplier(() => {
      phase = 'afterApply'
    })
    const revertedWith: ApplyResult[] = []
    const reverter = fakeReverter((r) => {
      revertedWith.push(r)
    })

    await runLoop(config, emitter, {
      admin: noopAdmin,
      providers: [provider],
      generator: fakeGenerator(product),
      applier,
      reverter,
      products: [product],
      queries: [makeQuery('q1', product.id), makeQuery('q2', product.id)],
      sleepMs: async () => {},
      propagationDelayMs: 0,
      cache: new FileCache(mkdtempSync(join(tmpdir(), 'shelf-cache-'))),
    })

    expect(reverter.revert).toHaveBeenCalledTimes(1)
    expect(revertedWith[0]?.productId).toBe(product.id)

    const logs = new JsonlLogger(paths.logFile).readAll()
    expect(logs.some((l) => l.verdict === 'reverted')).toBe(true)
  })

  it('stops with "budget exhausted" when the configured budget limit is zero', async () => {
    const paths = tmpPaths()
    const config = makeConfig({ maxIterations: 10, budgetLimitUsd: 0 }, paths)
    const emitter = new ShelfEventEmitter()
    const product = makeProduct()
    const scorer = fakeScorer(false, true)
    const applier = fakeApplier(() => {
      scorer.phase = 'afterApply'
    })

    const final = await runLoop(config, emitter, {
      admin: noopAdmin,
      providers: [scorer.provider],
      generator: fakeGenerator(product),
      applier,
      reverter: fakeReverter(() => {}),
      products: [product],
      queries: [makeQuery('q1', product.id)],
      sleepMs: async () => {},
      propagationDelayMs: 0,
      cache: new FileCache(mkdtempSync(join(tmpdir(), 'shelf-cache-'))),
    })

    expect(final.stopReason).toBe('budget exhausted')
    expect(applier.apply).not.toHaveBeenCalled()

    expect(existsSync(paths.sessionFile)).toBe(true)
    const md = readFileSync(paths.sessionFile, 'utf-8')
    expect(md).toContain('budget exhausted')
  })

  it('records generator_failed when the hypothesis generator throws', async () => {
    const paths = tmpPaths()
    const config = makeConfig({ maxIterations: 1 }, paths)
    const emitter = new ShelfEventEmitter()
    const product = makeProduct()
    const scorer = fakeScorer(false, false)
    const failingGenerator = {
      generate: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as HypothesisGenerator
    const applier = fakeApplier(() => {})

    await runLoop(config, emitter, {
      admin: noopAdmin,
      providers: [scorer.provider],
      generator: failingGenerator,
      applier,
      reverter: fakeReverter(() => {}),
      products: [product],
      queries: [makeQuery('q1', product.id)],
      sleepMs: async () => {},
      propagationDelayMs: 0,
      cache: new FileCache(mkdtempSync(join(tmpdir(), 'shelf-cache-'))),
    })

    expect(applier.apply).not.toHaveBeenCalled()
    const logs = new JsonlLogger(paths.logFile).readAll()
    const failed = logs.find((l) => l.verdict === 'generator_failed')
    expect(failed).toBeDefined()
    expect(failed?.error).toMatch(/boom/)
  })

  it('stops when maxIterations is hit without any product reaching the ceiling', async () => {
    const paths = tmpPaths()
    const config = makeConfig({ maxIterations: 2 }, paths)
    const emitter = new ShelfEventEmitter()
    const a = makeProduct('gid://shopify/Product/A', 'Jacket A')
    const b = makeProduct('gid://shopify/Product/B', 'Jacket B')
    const scorer: ScoringProvider = {
      name: 'anthropic',
      async score(q: ScoringQuery): Promise<ScoringResult> {
        return {
          queryId: q.id,
          provider: 'anthropic',
          appeared: false,
          latencyMs: 1,
          costUsd: 0.001,
          timestamp: new Date().toISOString(),
        }
      },
    }

    const final = await runLoop(config, emitter, {
      admin: noopAdmin,
      providers: [scorer],
      generator: fakeGenerator(a),
      applier: fakeApplier(() => {}),
      reverter: fakeReverter(() => {}),
      products: [a, b],
      queries: [makeQuery('qa', a.id), makeQuery('qb', b.id)],
      sleepMs: async () => {},
      propagationDelayMs: 0,
      cache: new FileCache(mkdtempSync(join(tmpdir(), 'shelf-cache-'))),
    })

    expect(final.stopReason).toBe('max iterations reached')
    expect(final.iteration).toBe(2)
  })
})
