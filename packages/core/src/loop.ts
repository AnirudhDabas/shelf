import { existsSync, readFileSync, statSync } from 'node:fs'
import { nanoid } from 'nanoid'
import type { ShelfConfig } from './config.js'
import { checkHypothesis } from './checks/backpressure.js'
import { computeConfidence } from './confidence/mad.js'
import type { ConfidenceResult } from './confidence/mad.js'
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
// Dry-run scorers return $0 so the cost meter stays flat, which makes
// demos look fake ("est. cost $0.000" for an hour-long run). Inject a
// realistic per-iteration stand-in that matches what a live run roughly
// costs ($0.08 × 25 iters ≈ $2). Only used when config.dryRun is true.
const DRY_RUN_COST_PER_ITER = 0.08
// Both the baseline and every per-iteration measurement sample the same
// slice of queries. Using different sizes (e.g. 10 for baseline, full 50
// per iteration) makes score deltas look smaller than they are because
// they compare apples to oranges. Capped for latency: 50q × 3p × 3r at
// baseline was 15+ minutes of dead air before the first hypothesis ran.
const MEASUREMENT_QUERY_SAMPLE = 50

// Sentinel used in stub hypotheses written when generation fails. Keeping
// it as a named constant (instead of a magic string) makes JSONL consumers
// like the trace exporter able to filter these out reliably.
const BASELINE_FIELD_SENTINEL = 'baseline'

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

// Single mutable scratchpad threaded through every per-iteration helper.
// All state that survives across iterations lives here; a helper that needs
// to influence the next iteration mutates this struct rather than returning
// a new value.
interface LoopContext {
  config: ShelfConfig
  emitter: ShelfEventEmitter
  generator: HypothesisGenerator
  applier: HypothesisApplier
  reverter: HypothesisReverter
  jsonl: JsonlLogger
  sessionLogger: SessionLogger
  budget: BudgetTracker
  providers: ScoringProvider[]
  products: ShopifyProduct[]
  queries: ScoringQuery[]
  storeCategory?: string
  startedAt: number
  now: () => number
  sleepFn: (ms: number) => Promise<void>
  propagationDelay: number
  iterationDelay: number
  mockCtx: MockContext
  currentScore: number
  currentByQuery: Record<string, boolean>
  lastModified: Map<string, number>
  tried: Map<string, Array<Pick<Hypothesis, 'type' | 'field' | 'after'>>>
  historicalDeltas: number[]
  recentVerdicts: Verdict[]
  budgetWarned: boolean
}

/**
 * Top-level orchestrator. Bootstraps dependencies, measures the baseline,
 * then drives the propose → apply → measure → decide loop until a stop
 * condition fires (budget exhausted, plateau, no recent wins, or max iters).
 *
 * Per-iteration logic lives in {@link runIteration}; stop conditions live
 * in {@link shouldStop}. This function should read top-to-bottom as the
 * shape of the algorithm, not the implementation of any single step.
 */
export async function runLoop(
  config: ShelfConfig,
  emitter: ShelfEventEmitter,
  deps: RunLoopDependencies = {},
): Promise<SessionState> {
  const ctx = await buildLoopContext(config, emitter, deps)

  const baseline = await measureBaseline(ctx)
  ctx.currentScore = baseline.overall
  ctx.currentByQuery = baseline.byQuery
  ctx.sessionLogger.start({ baselineScore: baseline.overall })
  emitSessionStart(ctx, baseline.overall)

  let stopReason = 'max iterations reached'
  let iteration = 0
  for (iteration = 1; iteration <= config.loop.maxIterations; iteration++) {
    ctx.mockCtx.iteration = iteration
    if (iteration > 1 && ctx.iterationDelay > 0) {
      await ctx.sleepFn(ctx.iterationDelay)
    }
    const stop = await runIteration(ctx, iteration)
    if (stop) {
      stopReason = stop
      break
    }
  }

  const finalState = ctx.sessionLogger.end(ctx.currentScore, stopReason)
  emitSessionEnd(ctx, iteration, baseline.overall, stopReason)
  return finalState
}

/**
 * Runs one cycle: pick a product, ask the generator for a hypothesis,
 * run backpressure checks, apply via Shopify, re-measure, decide keep
 * vs revert, log the experiment, and update session state.
 *
 * Returns a stop reason string when this iteration should also terminate
 * the outer loop (e.g. budget hit, all products at ceiling); otherwise
 * returns null and the outer loop continues. Failures inside a single
 * stage (generator, apply, measure) are logged as a `*_failed` verdict
 * and the iteration ends gracefully — they don't stop the loop.
 */
async function runIteration(ctx: LoopContext, iteration: number): Promise<string | null> {
  if (ctx.budget.exhausted()) return 'budget exhausted'
  // See DRY_RUN_COST_PER_ITER — stand-in cost so the budget meter visibly
  // increments during demos. Counted once per iteration regardless of
  // verdict (generator/apply/measure failures still consumed roughly that
  // compute in a real run).
  const iterCost = ctx.config.dryRun ? DRY_RUN_COST_PER_ITER : 0
  if (iterCost > 0) ctx.budget.add(iterCost)

  const perProduct = scoreProducts(ctx.products, ctx.queries, ctx.currentByQuery)
  const targeted = [...perProduct.values()].filter((r) => r.hasTargets)
  if (targeted.length > 0 && targeted.every((r) => r.score >= ALL_PRODUCTS_TARGET_SCORE)) {
    return `all products above ${ALL_PRODUCTS_TARGET_SCORE}/100`
  }
  const product = selectProduct(ctx.products, perProduct, ctx.lastModified, iteration)
  if (!product) return 'no eligible product (all in cooldown or at ceiling)'

  const iterStart = ctx.now()
  const failedQueries = ctx.queries
    .filter((q) => q.targetProductIds?.includes(product.id) && !ctx.currentByQuery[q.id])
    .map((q) => ({ id: q.id, text: q.text, intent: q.intent }))
  const priorAttempts = ctx.tried.get(product.id) ?? []

  let hypothesis: Hypothesis
  try {
    hypothesis = await ctx.generator.generate({
      product,
      failedQueries,
      triedHypotheses: priorAttempts,
      storeCategory: ctx.storeCategory,
    })
    ctx.budget.add(ctx.generator.lastCostUsd ?? 0)
  } catch (err) {
    const errMsg = errorMessage(err)
    recordFailure(ctx, {
      hypothesis: stubHypothesis(product),
      iteration,
      verdict: 'generator_failed',
      durationMs: ctx.now() - iterStart,
      costEstimateUsd: iterCost,
      product,
      reason: `generator: ${errMsg}`,
      error: `generator failed: ${errMsg}`,
    })
    return null
  }

  ctx.emitter.emit({
    type: 'hypothesis:proposed',
    iteration,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta: 0,
    confidence: 'noise',
    productId: product.id,
    hypothesis,
  })

  recordAttempt(ctx.tried, product.id, hypothesis)
  ctx.sessionLogger.recordAttempt()

  const checks = ctx.config.dryRun
    ? { passed: true, failures: [] as string[] }
    : checkHypothesis(hypothesis, product)
  if (!checks.passed) {
    recordChecksFailed(ctx, hypothesis, product, iteration, iterStart, iterCost, checks.failures)
    return null
  }

  let applyResult: ApplyResult
  try {
    applyResult = await ctx.applier.apply(hypothesis, product)
  } catch (err) {
    const errMsg = errorMessage(err)
    recordFailure(ctx, {
      hypothesis,
      iteration,
      verdict: 'apply_failed',
      durationMs: ctx.now() - iterStart,
      costEstimateUsd: iterCost,
      product,
      reason: `apply failed: ${errMsg}`,
      error: errMsg,
    })
    return null
  }

  ctx.emitter.emit({
    type: 'hypothesis:applied',
    iteration,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta: 0,
    confidence: 'noise',
    productId: product.id,
    hypothesisId: hypothesis.id,
    applyResult,
  })

  await ctx.sleepFn(ctx.propagationDelay)

  let measurement: AggregatedScore
  try {
    measurement = await measureIteration(ctx, iteration)
  } catch (err) {
    await handleMeasureFailure(ctx, err, applyResult, hypothesis, product, iteration, iterStart, iterCost)
    return null
  }

  ctx.budget.add(measurement.totalCostUsd)
  const scoreBefore = ctx.currentScore
  const scoreAfter = measurement.overall
  const scoreDelta = scoreAfter - scoreBefore
  const confidence = computeConfidence(scoreDelta, ctx.historicalDeltas)
  ctx.historicalDeltas.push(scoreDelta)

  ctx.emitter.emit({
    type: 'measurement:complete',
    iteration,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta,
    confidence: confidence.level,
    productId: product.id,
    scoreBefore,
    scoreAfter,
  })

  const { verdict } = decideVerdict(scoreBefore, scoreAfter, confidence)
  let revertResult: RevertResult | undefined
  let errorField: string | undefined

  if (verdict === 'kept' || verdict === 'kept_uncertain') {
    ctx.currentScore = scoreAfter
    ctx.currentByQuery = measurement.byQuery
    ctx.lastModified.set(product.id, iteration)
    ctx.sessionLogger.recordProductTouched(product.id)
  } else {
    try {
      revertResult = await ctx.reverter.revert(applyResult)
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
    durationMs: ctx.now() - iterStart,
    costEstimateUsd: measurement.totalCostUsd + iterCost,
    applyResult,
    revertResult,
    error: errorField,
  })
  recordExperiment(ctx, log, product.id, scoreDelta, confidence.level)

  if (verdict === 'kept' || verdict === 'kept_uncertain') {
    ctx.sessionLogger.recordKeyWin({
      iteration,
      productId: product.id,
      productTitle: hypothesis.productTitle,
      description: hypothesis.description,
      scoreDelta,
    })
  } else {
    ctx.sessionLogger.recordDeadEnd({
      iteration,
      productId: product.id,
      productTitle: hypothesis.productTitle,
      description: hypothesis.description,
      reason: errorField ?? `reverted (Δ ${scoreDelta.toFixed(2)}, ${confidence.level})`,
    })
  }
  ctx.recentVerdicts.push(verdict)
  persistSession(ctx, iteration)

  maybeEmitBudgetWarning(ctx, iteration)
  return shouldStop(ctx)
}

/**
 * Pure decision: given a score-before, score-after, and the MAD-derived
 * confidence, classify the experiment as kept / kept_uncertain / reverted.
 *
 * - Score went up + high confidence  → kept
 * - Score went up + lower confidence → kept_uncertain
 * - Score did not improve            → reverted
 *
 * Reasoning is included so callers can log *why* an experiment landed
 * where it did without re-deriving the rule.
 */
export function decideVerdict(
  scoreBefore: number,
  scoreAfter: number,
  confidence: ConfidenceResult,
): { verdict: 'kept' | 'kept_uncertain' | 'reverted'; reasoning: string } {
  if (scoreAfter > scoreBefore) {
    if (confidence.level === 'high') {
      return {
        verdict: 'kept',
        reasoning: `score improved (+${(scoreAfter - scoreBefore).toFixed(2)}) above MAD noise floor`,
      }
    }
    return {
      verdict: 'kept_uncertain',
      reasoning: `score improved (+${(scoreAfter - scoreBefore).toFixed(2)}) but confidence is ${confidence.level}`,
    }
  }
  return {
    verdict: 'reverted',
    reasoning: `score did not improve (Δ ${(scoreAfter - scoreBefore).toFixed(2)})`,
  }
}

/**
 * Persist a completed experiment: append to the JSONL log and emit the
 * matching SSE event so the live dashboard updates. Centralising this
 * keeps the JSONL-on-disk record and the wire stream in lockstep — every
 * keep/revert that reaches the log also reaches the dashboard.
 */
function recordExperiment(
  ctx: LoopContext,
  log: ExperimentLog,
  productId: string,
  scoreDelta: number,
  confidenceLevel: ConfidenceResult['level'],
): void {
  ctx.jsonl.append(log)
  const eventType =
    log.verdict === 'kept'
      ? 'experiment:kept'
      : log.verdict === 'kept_uncertain'
        ? 'experiment:kept_uncertain'
        : 'experiment:reverted'
  ctx.emitter.emit({
    type: eventType,
    iteration: log.iteration,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta,
    confidence: confidenceLevel,
    productId,
    log,
  })
}

/**
 * Loop-level stop conditions that can fire at the end of any iteration.
 * Returns a human-readable reason when the loop should terminate, or null
 * to continue. Order matters: budget is hardest stop (no more spend),
 * then dryness checks (no recent wins / score plateau).
 */
function shouldStop(ctx: LoopContext): string | null {
  if (ctx.budget.exhausted()) return 'budget exhausted'
  if (ctx.recentVerdicts.length >= NO_KEEP_STOP_WINDOW) {
    const window = ctx.recentVerdicts.slice(-NO_KEEP_STOP_WINDOW)
    if (!window.some((v) => v === 'kept' || v === 'kept_uncertain')) {
      return `no kept changes in last ${NO_KEEP_STOP_WINDOW} iterations`
    }
  }
  if (ctx.historicalDeltas.length >= PLATEAU_WINDOW) {
    const window = ctx.historicalDeltas.slice(-PLATEAU_WINDOW)
    const avg = window.reduce((s, d) => s + d, 0) / window.length
    if (avg < PLATEAU_THRESHOLD) {
      return `score improvement averaged ${avg.toFixed(2)}/iter over last ${PLATEAU_WINDOW}`
    }
  }
  return null
}

async function buildLoopContext(
  config: ShelfConfig,
  emitter: ShelfEventEmitter,
  deps: RunLoopDependencies,
): Promise<LoopContext> {
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
  if (existsSync(jsonl.filePath) && statSync(jsonl.filePath).size > 0) {
    logPhase(
      `⚠ ${jsonl.filePath} already exists — truncating (previous run's experiments will be lost).`,
    )
  }
  jsonl.reset()
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

  // Both baseline and per-iteration measurements must score the same
  // query set — otherwise score deltas are incomparable.
  if (queries.length > MEASUREMENT_QUERY_SAMPLE) {
    queries = queries.slice(0, MEASUREMENT_QUERY_SAMPLE)
  }

  return {
    config,
    emitter,
    generator,
    applier,
    reverter,
    jsonl,
    sessionLogger,
    budget,
    providers,
    products,
    queries,
    storeCategory: deps.storeCategory,
    startedAt: now(),
    now,
    sleepFn,
    propagationDelay,
    iterationDelay,
    mockCtx,
    currentScore: 0,
    currentByQuery: {},
    lastModified: new Map(),
    tried: new Map(),
    historicalDeltas: [],
    recentVerdicts: [],
    budgetWarned: false,
  }
}

async function measureBaseline(ctx: LoopContext): Promise<AggregatedScore> {
  logPhase(
    `• measuring baseline: ${ctx.queries.length} queries × ${ctx.providers.length} providers × ${ctx.config.loop.queriesPerMeasurement} reps`,
  )
  const baselineTotal =
    ctx.queries.length * ctx.providers.length * ctx.config.loop.queriesPerMeasurement
  const baseline = await measureScore(ctx.queries, ctx.config.store.domain, ctx.providers, {
    repetitions: ctx.config.loop.queriesPerMeasurement,
    onResult: progressWriter('baseline', baselineTotal),
  })
  ctx.budget.add(baseline.totalCostUsd)
  logPhase(
    `  → baseline ${baseline.overall.toFixed(1)}/100 (cost $${baseline.totalCostUsd.toFixed(2)})`,
  )
  return baseline
}

async function measureIteration(ctx: LoopContext, iteration: number): Promise<AggregatedScore> {
  const iterTotal =
    ctx.queries.length * ctx.providers.length * ctx.config.loop.queriesPerMeasurement
  logPhase(
    `  iter ${iteration}: measuring ${ctx.queries.length} queries × ${ctx.providers.length} providers × ${ctx.config.loop.queriesPerMeasurement} reps`,
  )
  return measureScore(ctx.queries, ctx.config.store.domain, ctx.providers, {
    repetitions: ctx.config.loop.queriesPerMeasurement,
    onResult: progressWriter(`iter ${iteration}`, iterTotal),
  })
}

interface FailureRecord {
  hypothesis: Hypothesis
  iteration: number
  verdict: Verdict
  durationMs: number
  costEstimateUsd: number
  product: ShopifyProduct
  reason: string
  error: string
}

function recordFailure(ctx: LoopContext, f: FailureRecord): void {
  ctx.jsonl.append(
    buildLog({
      hypothesis: f.hypothesis,
      iteration: f.iteration,
      verdict: f.verdict,
      scoreBefore: ctx.currentScore,
      scoreAfter: ctx.currentScore,
      scoreDelta: 0,
      confidenceScore: 0,
      confidenceLevel: 'noise',
      durationMs: f.durationMs,
      costEstimateUsd: f.costEstimateUsd,
      error: f.error,
    }),
  )
  if (f.verdict === 'generator_failed') {
    ctx.sessionLogger.recordAttempt()
  }
  ctx.sessionLogger.recordDeadEnd({
    iteration: f.iteration,
    productId: f.product.id,
    productTitle: f.hypothesis.productTitle || f.product.title,
    description:
      f.verdict === 'generator_failed'
        ? 'hypothesis generation failed'
        : f.hypothesis.description,
    reason: f.reason,
  })
  ctx.recentVerdicts.push(f.verdict)
  persistSession(ctx, f.iteration)
}

function recordChecksFailed(
  ctx: LoopContext,
  hypothesis: Hypothesis,
  product: ShopifyProduct,
  iteration: number,
  iterStart: number,
  iterCost: number,
  failures: string[],
): void {
  const log = buildLog({
    hypothesis,
    iteration,
    verdict: 'checks_failed',
    scoreBefore: ctx.currentScore,
    scoreAfter: ctx.currentScore,
    scoreDelta: 0,
    confidenceScore: 0,
    confidenceLevel: 'noise',
    durationMs: ctx.now() - iterStart,
    costEstimateUsd: iterCost,
    failures,
  })
  ctx.jsonl.append(log)
  ctx.emitter.emit({
    type: 'checks:failed',
    iteration,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta: 0,
    confidence: 'noise',
    productId: product.id,
    hypothesisId: hypothesis.id,
    failures,
  })
  ctx.sessionLogger.recordDeadEnd({
    iteration,
    productId: product.id,
    productTitle: hypothesis.productTitle,
    description: hypothesis.description,
    reason: `checks failed: ${failures[0] ?? 'unknown'}`,
  })
  ctx.recentVerdicts.push('checks_failed')
  persistSession(ctx, iteration)
}

async function handleMeasureFailure(
  ctx: LoopContext,
  err: unknown,
  applyResult: ApplyResult,
  hypothesis: Hypothesis,
  product: ShopifyProduct,
  iteration: number,
  iterStart: number,
  iterCost: number,
): Promise<void> {
  const errMsg = errorMessage(err)
  let revertError: string | undefined
  let revertResult: RevertResult | undefined
  try {
    revertResult = await ctx.reverter.revert(applyResult)
  } catch (revertErr) {
    revertError = errorMessage(revertErr)
  }
  const log = buildLog({
    hypothesis,
    iteration,
    verdict: 'measure_failed',
    scoreBefore: ctx.currentScore,
    scoreAfter: ctx.currentScore,
    scoreDelta: 0,
    confidenceScore: 0,
    confidenceLevel: 'noise',
    durationMs: ctx.now() - iterStart,
    costEstimateUsd: iterCost,
    applyResult,
    revertResult,
    error: revertError ? `${errMsg}; revert failed: ${revertError}` : errMsg,
  })
  ctx.jsonl.append(log)
  ctx.sessionLogger.recordDeadEnd({
    iteration,
    productId: product.id,
    productTitle: hypothesis.productTitle,
    description: hypothesis.description,
    reason: revertError
      ? `measure failed: ${errMsg}; revert failed: ${revertError}`
      : `measure failed: ${errMsg}`,
  })
  ctx.recentVerdicts.push('measure_failed')
  persistSession(ctx, iteration)
}

function maybeEmitBudgetWarning(ctx: LoopContext, iteration: number): void {
  if (ctx.budgetWarned) return
  if (ctx.budget.total() < BUDGET_WARN_FRACTION * ctx.config.loop.budgetLimitUsd) return
  ctx.emitter.emit({
    type: 'budget:warning',
    iteration,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta: 0,
    confidence: 'noise',
    cumulativeCostUsd: ctx.budget.total(),
    limitUsd: ctx.config.loop.budgetLimitUsd,
    remainingUsd: ctx.budget.remaining(),
  })
  ctx.budgetWarned = true
}

function emitSessionStart(ctx: LoopContext, baselineScore: number): void {
  ctx.emitter.emit({
    type: 'session:start',
    iteration: 0,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta: 0,
    confidence: 'noise',
    baselineScore,
    queriesCount: ctx.queries.length,
    productsCount: ctx.products.length,
    maxIterations: ctx.config.loop.maxIterations,
    budgetLimitUsd: ctx.config.loop.budgetLimitUsd,
  })
}

function emitSessionEnd(
  ctx: LoopContext,
  iteration: number,
  baselineScore: number,
  stopReason: string,
): void {
  ctx.emitter.emit({
    type: 'session:end',
    iteration,
    elapsedMs: ctx.now() - ctx.startedAt,
    costUsd: ctx.budget.total(),
    scoreDelta: ctx.currentScore - baselineScore,
    confidence: 'noise',
    finalScore: ctx.currentScore,
    baselineScore,
    totalIterations: ctx.sessionLogger.state?.iteration ?? iteration,
    totalCostUsd: ctx.budget.total(),
    stopReason,
  })
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

function persistSession(ctx: LoopContext, iteration: number): void {
  ctx.sessionLogger.update({
    iteration,
    currentScore: ctx.currentScore,
    cumulativeCostUsd: ctx.budget.total(),
    elapsedMs: ctx.now() - ctx.startedAt,
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
export function loadFixtureProducts(): ShopifyProduct[] {
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
    field: BASELINE_FIELD_SENTINEL,
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
