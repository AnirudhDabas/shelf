import { readFileSync } from 'node:fs'
import { nanoid } from 'nanoid'
import type { ShelfConfig } from './config.js'
import { checkHypothesis } from './checks/backpressure.js'
import { computeConfidence } from './confidence/mad.js'
import { ShelfEventEmitter } from './events/emitter.js'
import {
  HypothesisApplier,
  HypothesisGenerator,
  HypothesisReverter,
} from './hypothesis/index.js'
import type {
  ApplyResult,
  Hypothesis,
  RevertResult,
} from './hypothesis/types.js'
import { JsonlLogger } from './logger/jsonl.js'
import type { ExperimentLog, Verdict } from './logger/jsonl.js'
import { SessionLogger } from './logger/session.js'
import type { SessionState } from './logger/session.js'
import { QueryGenerator } from './queries/generator.js'
import { buildProviders, measureScore } from './scorer/index.js'
import type { MockContext } from './scorer/mock.js'
import type { AggregatedScore, ScoringProvider, ScoringQuery } from './scorer/types.js'
import { ShopifyAdminClient } from './shopify/admin.js'
import type { ShopifyProduct } from './shopify/types.js'
import { FileCache } from './utils/cache.js'
import { BudgetTracker } from './utils/cost.js'
import { sleep } from './utils/retry.js'

const PROPAGATION_DELAY_MS = 8_000
const COOLDOWN_ITERATIONS = 3
const NO_KEEP_STOP_WINDOW = 10
const PLATEAU_WINDOW = 15
const PLATEAU_THRESHOLD = 0.5
const ALL_PRODUCTS_TARGET_SCORE = 90
const BUDGET_WARN_FRACTION = 0.8
const DEFAULT_QUERY_COUNT = 50
// Baseline only samples a subset — per-iteration measurements still hit
// the full set so keep/revert decisions stay statistically sound. Without
// this, a 50q × 3p × 3r baseline meant 15+ minutes of dead air at startup.
const BASELINE_QUERY_SAMPLE = 10

function logPhase(msg: string): void {
  process.stdout.write(`${msg}\n`)
}

function progressWriter(label: string, total: number): () => void {
  let done = 0
  return () => {
    done++
    if (process.stderr.isTTY) {
      process.stderr.write(`\r  ${label}: ${done}/${total}`)
      if (done === total) process.stderr.write('\n')
    } else if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
      process.stderr.write(`  ${label}: ${done}/${total}\n`)
    }
  }
}

export interface RunLoopDependencies {
  admin?: ShopifyAdminClient
  providers?: ScoringProvider[]
  generator?: HypothesisGenerator
  applier?: HypothesisApplier
  reverter?: HypothesisReverter
  queryGenerator?: QueryGenerator
  sessionLogger?: SessionLogger
  jsonl?: JsonlLogger
  cache?: FileCache
  products?: ShopifyProduct[]
  queries?: ScoringQuery[]
  sleepMs?: (ms: number) => Promise<void>
  now?: () => number
  propagationDelayMs?: number
  iterationDelayMs?: number
  queryCount?: number
  storeCategory?: string
}

export async function runLoop(
  config: ShelfConfig,
  emitter: ShelfEventEmitter,
  deps: RunLoopDependencies = {},
): Promise<SessionState> {
  const anthropicKey = config.dryRun ? undefined : requireAnthropicKey(config)
  const now = deps.now ?? (() => Date.now())
  const sleepFn = deps.sleepMs ?? sleep
  const propagationDelay = deps.propagationDelayMs ?? (config.dryRun ? 0 : PROPAGATION_DELAY_MS)
  const iterationDelay = deps.iterationDelayMs ?? 0

  const admin =
    deps.admin ??
    (config.noShopify
      ? (undefined as unknown as ShopifyAdminClient)
      : await ShopifyAdminClient.create({
          storeDomain: config.store.domain,
          accessToken: config.store.adminAccessToken,
          clientId: config.store.clientId,
          clientSecret: config.store.clientSecret,
        }))
  const cache = deps.cache ?? new FileCache()
  const mockCtx: MockContext = { iteration: 0 }
  const providers =
    deps.providers ??
    buildProviders(config, { cache, dryRun: config.dryRun, mockContext: mockCtx })
  if (providers.length === 0) {
    throw new Error('runLoop: no scoring providers configured')
  }
  const generator =
    deps.generator ??
    new HypothesisGenerator({ apiKey: anthropicKey, dryRun: config.dryRun })
  const applier = deps.applier ?? new HypothesisApplier(admin, { dryRun: config.dryRun })
  const reverter = deps.reverter ?? new HypothesisReverter(admin, { dryRun: config.dryRun })
  const sessionLogger = deps.sessionLogger ?? new SessionLogger(config.paths.sessionFile)
  const jsonl = deps.jsonl ?? new JsonlLogger(config.paths.logFile)
  const budget = new BudgetTracker(config.loop.budgetLimitUsd)

  let products = deps.products
  if (!products) {
    if (config.noShopify) {
      logPhase('• loading products from fixtures/demo-store/products.json (--no-shopify)…')
      products = loadFixtureProducts()
    } else {
      logPhase('• fetching products from Shopify Admin API…')
      products = await admin.listProducts()
    }
    logPhase(`  → ${products.length} products`)
  }

  let queries = deps.queries
  if (!queries) {
    const targetCount = deps.queryCount ?? DEFAULT_QUERY_COUNT
    if (config.dryRun) {
      logPhase(`• loading ${targetCount} fixture queries (dry-run)…`)
    } else {
      logPhase(`• generating ${targetCount} shopper queries via Anthropic…`)
    }
    const queryGen =
      deps.queryGenerator ??
      new QueryGenerator({ apiKey: anthropicKey, dryRun: config.dryRun })
    queries = await queryGen.generate({
      products,
      count: targetCount,
      storeCategory: deps.storeCategory,
    })
    budget.add(queryGen.lastCostUsd ?? 0)
    logPhase(`  → ${queries.length} queries (cost $${(queryGen.lastCostUsd ?? 0).toFixed(3)})`)
  }

  const startedAt = now()
  const baselineQueries = queries.slice(0, BASELINE_QUERY_SAMPLE)
  logPhase(
    `• measuring baseline: ${baselineQueries.length} queries × ${providers.length} providers × ${config.loop.queriesPerMeasurement} reps`,
  )
  const baselineTotal =
    baselineQueries.length * providers.length * config.loop.queriesPerMeasurement
  const baseline = await measureScore(baselineQueries, config.store.domain, providers, {
    repetitions: config.loop.queriesPerMeasurement,
    onResult: progressWriter('baseline', baselineTotal),
  })
  budget.add(baseline.totalCostUsd)
  logPhase(
    `  → baseline ${baseline.overall.toFixed(1)}/100 (cost $${baseline.totalCostUsd.toFixed(2)})`,
  )

  sessionLogger.start({ baselineScore: baseline.overall })
  emitter.emit({
    type: 'session:start',
    iteration: 0,
    elapsedMs: now() - startedAt,
    costUsd: budget.total(),
    scoreDelta: 0,
    confidence: 'noise',
    baselineScore: baseline.overall,
    queriesCount: queries.length,
    productsCount: products.length,
    maxIterations: config.loop.maxIterations,
    budgetLimitUsd: config.loop.budgetLimitUsd,
  })

  let currentByQuery = baseline.byQuery
  let currentScore = baseline.overall
  const lastModified = new Map<string, number>()
  const tried = new Map<string, Array<Pick<Hypothesis, 'type' | 'field' | 'after'>>>()
  const historicalDeltas: number[] = []
  const recentVerdicts: Verdict[] = []
  let budgetWarned = false
  let stopReason = 'max iterations reached'
  let iteration = 0

  for (iteration = 1; iteration <= config.loop.maxIterations; iteration++) {
    mockCtx.iteration = iteration
    if (iteration > 1 && iterationDelay > 0) {
      await sleepFn(iterationDelay)
    }
    if (budget.exhausted()) {
      stopReason = 'budget exhausted'
      break
    }

    const perProduct = scoreProducts(products, queries, currentByQuery)
    const targeted = [...perProduct.values()].filter((r) => r.hasTargets)
    if (targeted.length > 0 && targeted.every((r) => r.score >= ALL_PRODUCTS_TARGET_SCORE)) {
      stopReason = `all products above ${ALL_PRODUCTS_TARGET_SCORE}/100`
      break
    }

    const selection = selectProduct(products, perProduct, lastModified, iteration)
    if (!selection) {
      stopReason = 'no eligible product (all in cooldown or at ceiling)'
      break
    }
    const product = selection

    const iterStart = now()
    const failedQueries = queries
      .filter((q) => q.targetProductIds?.includes(product.id) && !currentByQuery[q.id])
      .map((q) => ({ id: q.id, text: q.text, intent: q.intent }))
    const priorAttempts = tried.get(product.id) ?? []

    let hypothesis: Hypothesis
    try {
      hypothesis = await generator.generate({
        product,
        failedQueries,
        triedHypotheses: priorAttempts,
        storeCategory: deps.storeCategory,
      })
      budget.add(generator.lastCostUsd ?? 0)
    } catch (err) {
      const errMsg = errorMessage(err)
      const stub = stubHypothesis(product)
      jsonl.append(
        buildLog({
          hypothesis: stub,
          iteration,
          verdict: 'apply_failed',
          scoreBefore: currentScore,
          scoreAfter: currentScore,
          scoreDelta: 0,
          confidenceScore: 0,
          confidenceLevel: 'noise',
          durationMs: now() - iterStart,
          costEstimateUsd: 0,
          error: `generator failed: ${errMsg}`,
        }),
      )
      sessionLogger.recordAttempt()
      sessionLogger.recordDeadEnd({
        iteration,
        productId: product.id,
        productTitle: product.title,
        description: 'hypothesis generation failed',
        reason: `generator: ${errMsg}`,
      })
      recentVerdicts.push('apply_failed')
      persistSession(sessionLogger, iteration, currentScore, budget, startedAt, now())
      continue
    }

    emitter.emit({
      type: 'hypothesis:proposed',
      iteration,
      elapsedMs: now() - startedAt,
      costUsd: budget.total(),
      scoreDelta: 0,
      confidence: 'noise',
      productId: product.id,
      hypothesis,
    })

    recordAttempt(tried, product.id, hypothesis)
    sessionLogger.recordAttempt()

    const checks = checkHypothesis(hypothesis, product)
    if (!checks.passed) {
      const log = buildLog({
        hypothesis,
        iteration,
        verdict: 'checks_failed',
        scoreBefore: currentScore,
        scoreAfter: currentScore,
        scoreDelta: 0,
        confidenceScore: 0,
        confidenceLevel: 'noise',
        durationMs: now() - iterStart,
        costEstimateUsd: 0,
        failures: checks.failures,
      })
      jsonl.append(log)
      emitter.emit({
        type: 'checks:failed',
        iteration,
        elapsedMs: now() - startedAt,
        costUsd: budget.total(),
        scoreDelta: 0,
        confidence: 'noise',
        productId: product.id,
        hypothesisId: hypothesis.id,
        failures: checks.failures,
      })
      sessionLogger.recordDeadEnd({
        iteration,
        productId: product.id,
        productTitle: hypothesis.productTitle,
        description: hypothesis.description,
        reason: `checks failed: ${checks.failures[0] ?? 'unknown'}`,
      })
      recentVerdicts.push('checks_failed')
      persistSession(sessionLogger, iteration, currentScore, budget, startedAt, now())
      continue
    }

    let applyResult: ApplyResult
    try {
      applyResult = await applier.apply(hypothesis, product)
    } catch (err) {
      const errMsg = errorMessage(err)
      const log = buildLog({
        hypothesis,
        iteration,
        verdict: 'apply_failed',
        scoreBefore: currentScore,
        scoreAfter: currentScore,
        scoreDelta: 0,
        confidenceScore: 0,
        confidenceLevel: 'noise',
        durationMs: now() - iterStart,
        costEstimateUsd: 0,
        error: errMsg,
      })
      jsonl.append(log)
      sessionLogger.recordDeadEnd({
        iteration,
        productId: product.id,
        productTitle: hypothesis.productTitle,
        description: hypothesis.description,
        reason: `apply failed: ${errMsg}`,
      })
      recentVerdicts.push('apply_failed')
      persistSession(sessionLogger, iteration, currentScore, budget, startedAt, now())
      continue
    }

    emitter.emit({
      type: 'hypothesis:applied',
      iteration,
      elapsedMs: now() - startedAt,
      costUsd: budget.total(),
      scoreDelta: 0,
      confidence: 'noise',
      productId: product.id,
      hypothesisId: hypothesis.id,
      applyResult,
    })

    await sleepFn(propagationDelay)

    const iterTotal = queries.length * providers.length * config.loop.queriesPerMeasurement
    logPhase(
      `  iter ${iteration}: measuring ${queries.length} queries × ${providers.length} providers × ${config.loop.queriesPerMeasurement} reps`,
    )
    let measurement: AggregatedScore
    try {
      measurement = await measureScore(queries, config.store.domain, providers, {
        repetitions: config.loop.queriesPerMeasurement,
        onResult: progressWriter(`iter ${iteration}`, iterTotal),
      })
    } catch (err) {
      const errMsg = errorMessage(err)
      let revertError: string | undefined
      try {
        await reverter.revert(applyResult)
      } catch (revertErr) {
        revertError = errorMessage(revertErr)
      }
      const log = buildLog({
        hypothesis,
        iteration,
        verdict: 'measure_failed',
        scoreBefore: currentScore,
        scoreAfter: currentScore,
        scoreDelta: 0,
        confidenceScore: 0,
        confidenceLevel: 'noise',
        durationMs: now() - iterStart,
        costEstimateUsd: 0,
        applyResult,
        error: revertError ? `${errMsg}; revert failed: ${revertError}` : errMsg,
      })
      jsonl.append(log)
      sessionLogger.recordDeadEnd({
        iteration,
        productId: product.id,
        productTitle: hypothesis.productTitle,
        description: hypothesis.description,
        reason: revertError ? `measure failed: ${errMsg}; revert failed: ${revertError}` : `measure failed: ${errMsg}`,
      })
      recentVerdicts.push('measure_failed')
      persistSession(sessionLogger, iteration, currentScore, budget, startedAt, now())
      continue
    }

    budget.add(measurement.totalCostUsd)
    const scoreBefore = currentScore
    const scoreAfter = measurement.overall
    const scoreDelta = scoreAfter - scoreBefore
    const confidence = computeConfidence(scoreDelta, historicalDeltas)
    historicalDeltas.push(scoreDelta)

    emitter.emit({
      type: 'measurement:complete',
      iteration,
      elapsedMs: now() - startedAt,
      costUsd: budget.total(),
      scoreDelta,
      confidence: confidence.level,
      productId: product.id,
      scoreBefore,
      scoreAfter,
    })

    let verdict: Verdict
    let revertResult: RevertResult | undefined
    let errorField: string | undefined

    if (scoreAfter > scoreBefore) {
      if (confidence.level === 'high') {
        verdict = 'kept'
      } else {
        verdict = 'kept_uncertain'
      }
      currentScore = scoreAfter
      currentByQuery = measurement.byQuery
      lastModified.set(product.id, iteration)
      sessionLogger.recordProductTouched(product.id)
    } else {
      verdict = 'reverted'
      try {
        revertResult = await reverter.revert(applyResult)
      } catch (err) {
        errorField = `revert failed: ${errorMessage(err)}`
      }
    }

    const log = buildLog({
      hypothesis,
      iteration,
      verdict,
      scoreBefore,
      scoreAfter,
      scoreDelta,
      confidenceScore: isFinite(confidence.score) ? confidence.score : 1000,
      confidenceLevel: confidence.level,
      durationMs: now() - iterStart,
      costEstimateUsd: measurement.totalCostUsd,
      applyResult,
      revertResult,
      error: errorField,
    })
    jsonl.append(log)

    const eventType =
      verdict === 'kept'
        ? 'experiment:kept'
        : verdict === 'kept_uncertain'
          ? 'experiment:kept_uncertain'
          : 'experiment:reverted'
    emitter.emit({
      type: eventType,
      iteration,
      elapsedMs: now() - startedAt,
      costUsd: budget.total(),
      scoreDelta,
      confidence: confidence.level,
      productId: product.id,
      log,
    })
    if (verdict === 'kept' || verdict === 'kept_uncertain') {
      sessionLogger.recordKeyWin({
        iteration,
        productId: product.id,
        productTitle: hypothesis.productTitle,
        description: hypothesis.description,
        scoreDelta,
      })
    } else {
      sessionLogger.recordDeadEnd({
        iteration,
        productId: product.id,
        productTitle: hypothesis.productTitle,
        description: hypothesis.description,
        reason: errorField ?? `reverted (Δ ${scoreDelta.toFixed(2)}, ${confidence.level})`,
      })
    }
    recentVerdicts.push(verdict)
    persistSession(sessionLogger, iteration, currentScore, budget, startedAt, now())

    if (
      !budgetWarned &&
      budget.total() >= BUDGET_WARN_FRACTION * config.loop.budgetLimitUsd
    ) {
      emitter.emit({
        type: 'budget:warning',
        iteration,
        elapsedMs: now() - startedAt,
        costUsd: budget.total(),
        scoreDelta: 0,
        confidence: 'noise',
        cumulativeCostUsd: budget.total(),
        limitUsd: config.loop.budgetLimitUsd,
        remainingUsd: budget.remaining(),
      })
      budgetWarned = true
    }

    if (budget.exhausted()) {
      stopReason = 'budget exhausted'
      break
    }

    if (recentVerdicts.length >= NO_KEEP_STOP_WINDOW) {
      const window = recentVerdicts.slice(-NO_KEEP_STOP_WINDOW)
      if (!window.some((v) => v === 'kept' || v === 'kept_uncertain')) {
        stopReason = `no kept changes in last ${NO_KEEP_STOP_WINDOW} iterations`
        break
      }
    }

    if (historicalDeltas.length >= PLATEAU_WINDOW) {
      const window = historicalDeltas.slice(-PLATEAU_WINDOW)
      const avg = window.reduce((s, d) => s + d, 0) / window.length
      if (avg < PLATEAU_THRESHOLD) {
        stopReason = `score improvement averaged ${avg.toFixed(2)}/iter over last ${PLATEAU_WINDOW}`
        break
      }
    }
  }

  const finalState = sessionLogger.end(currentScore, stopReason)
  emitter.emit({
    type: 'session:end',
    iteration,
    elapsedMs: now() - startedAt,
    costUsd: budget.total(),
    scoreDelta: currentScore - baseline.overall,
    confidence: 'noise',
    finalScore: currentScore,
    baselineScore: baseline.overall,
    totalIterations: finalState.iteration,
    totalCostUsd: budget.total(),
    stopReason,
  })
  return finalState
}

interface PerProductScore {
  productId: string
  score: number
  hasTargets: boolean
}

function scoreProducts(
  products: ShopifyProduct[],
  queries: ScoringQuery[],
  byQuery: Record<string, boolean>,
): Map<string, PerProductScore> {
  const counts = new Map<string, { matched: number; total: number }>()
  for (const p of products) counts.set(p.id, { matched: 0, total: 0 })
  for (const q of queries) {
    if (!q.targetProductIds?.length) continue
    const appeared = byQuery[q.id] ?? false
    for (const pid of q.targetProductIds) {
      const bucket = counts.get(pid)
      if (!bucket) continue
      bucket.total += 1
      if (appeared) bucket.matched += 1
    }
  }
  const result = new Map<string, PerProductScore>()
  for (const [pid, b] of counts) {
    result.set(pid, {
      productId: pid,
      hasTargets: b.total > 0,
      score: b.total === 0 ? 0 : (b.matched / b.total) * 100,
    })
  }
  return result
}

function selectProduct(
  products: ShopifyProduct[],
  perProduct: Map<string, PerProductScore>,
  lastModified: Map<string, number>,
  iteration: number,
): ShopifyProduct | null {
  const eligible: Array<{ product: ShopifyProduct; score: number }> = []
  for (const p of products) {
    const mod = lastModified.get(p.id)
    if (mod !== undefined && iteration - mod < COOLDOWN_ITERATIONS) continue
    const ps = perProduct.get(p.id)
    if (!ps || !ps.hasTargets) continue
    if (ps.score >= 100) continue
    eligible.push({ product: p, score: ps.score })
  }
  if (eligible.length === 0) return null
  eligible.sort((a, b) => a.score - b.score)
  return eligible[0].product
}

function recordAttempt(
  tried: Map<string, Array<Pick<Hypothesis, 'type' | 'field' | 'after'>>>,
  productId: string,
  hypothesis: Hypothesis,
): void {
  const list = tried.get(productId) ?? []
  list.push({ type: hypothesis.type, field: hypothesis.field, after: hypothesis.after })
  tried.set(productId, list)
}

interface BuildLogInput {
  hypothesis: Hypothesis
  iteration: number
  verdict: Verdict
  scoreBefore: number
  scoreAfter: number
  scoreDelta: number
  confidenceScore: number
  confidenceLevel: ExperimentLog['confidenceLevel']
  durationMs: number
  costEstimateUsd: number
  failures?: string[]
  error?: string
  applyResult?: ApplyResult
  revertResult?: RevertResult
}

function buildLog(input: BuildLogInput): ExperimentLog {
  return {
    id: nanoid(),
    iteration: input.iteration,
    timestamp: new Date().toISOString(),
    hypothesis: input.hypothesis,
    verdict: input.verdict,
    scoreBefore: input.scoreBefore,
    scoreAfter: input.scoreAfter,
    scoreDelta: input.scoreDelta,
    confidence: input.confidenceScore,
    confidenceLevel: input.confidenceLevel,
    durationMs: input.durationMs,
    costEstimateUsd: input.costEstimateUsd,
    failures: input.failures,
    error: input.error,
    applyResult: input.applyResult,
    revertResult: input.revertResult,
  }
}

function persistSession(
  sessionLogger: SessionLogger,
  iteration: number,
  currentScore: number,
  budget: BudgetTracker,
  startedAt: number,
  nowMs: number,
): void {
  sessionLogger.update({
    iteration,
    currentScore,
    cumulativeCostUsd: budget.total(),
    elapsedMs: nowMs - startedAt,
  })
}

interface FixtureProductSeed {
  title: string
  descriptionHtml: string
  vendor?: string
  productType?: string
  tags?: string[]
  price?: string
  sizes?: string[]
  image?: string
}

// Turn the tiny demo-store seed (title/description/vendor only) into
// fully-shaped ShopifyProduct records for --no-shopify mode. Fabricates
// stable GIDs so scorer/applier/reverter see the same shape they would
// from a real Admin API response.
function loadFixtureProducts(): ShopifyProduct[] {
  const fixturePath = new URL(
    '../../../fixtures/demo-store/products.json',
    import.meta.url,
  )
  const raw = readFileSync(fixturePath, 'utf-8')
  const seeds = JSON.parse(raw) as FixtureProductSeed[]
  return seeds.map((s, i) => {
    const id = `gid://shopify/Product/${1000000000000 + i}`
    const variants = (s.sizes ?? ['default']).map((size, vi) => ({
      id: `gid://shopify/ProductVariant/${2000000000000 + i * 100 + vi}`,
      title: size,
      price: s.price ?? '0.00',
      availableForSale: true,
      sku: null,
    }))
    return {
      id,
      title: s.title,
      descriptionHtml: s.descriptionHtml,
      productType: s.productType ?? null,
      vendor: s.vendor ?? null,
      tags: s.tags ?? [],
      seo: { title: null, description: null },
      metafields: [],
      variants,
      images: s.image ? [{ url: s.image, altText: null }] : [],
    }
  })
}

function stubHypothesis(product: ShopifyProduct): Hypothesis {
  return {
    id: nanoid(),
    type: 'title_rewrite',
    productId: product.id,
    productTitle: product.title,
    field: '(none)',
    before: '',
    after: '',
    description: 'hypothesis generation failed',
    reasoning: '',
    queryFailurePatterns: [],
    predictedEffect: '',
    riskLevel: 'low',
    confidence: 'low',
    estimatedImpact: '',
    promptVersion: 'hypothesis.v1',
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function requireAnthropicKey(config: ShelfConfig): string {
  const key = config.providers.anthropic?.apiKey
  if (!key) {
    throw new Error(
      'runLoop requires ANTHROPIC_API_KEY for hypothesis and query generation',
    )
  }
  return key
}
