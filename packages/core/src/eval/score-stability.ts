import { measureScore } from '../scorer/index.js'
import type { ScoringProvider, ScoringQuery } from '../scorer/types.js'
import type { ShopifyProduct } from '../shopify/types.js'
import type {
  ScoreStabilityProductRow,
  ScoreStabilityReport,
  ScoreStabilityVerdict,
} from './types.js'

const DEFAULT_RUNS = 5
const DEFAULT_PRODUCTS = 5

export interface StabilityInput {
  products: ShopifyProduct[]
  queries: ScoringQuery[]
  providers: ScoringProvider[]
  storeDomain: string
  runs?: number
  productCount?: number
  repetitions?: number
  // Hook so the CLI can render progress; not required for the analysis.
  onRun?: (run: number, total: number) => void
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance =
    values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1)
  return Math.sqrt(variance)
}

// Pick the products with the most associated queries — those have the
// highest-resolution per-product score, which gives the variance estimate
// something to work with.
function pickProducts(products: ShopifyProduct[], queries: ScoringQuery[], n: number): ShopifyProduct[] {
  const queryCounts = new Map<string, number>()
  for (const q of queries) {
    for (const pid of q.targetProductIds ?? []) {
      queryCounts.set(pid, (queryCounts.get(pid) ?? 0) + 1)
    }
  }
  const ranked = products
    .map((p) => ({ product: p, count: queryCounts.get(p.id) ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  if (ranked.length === 0) return products.slice(0, n)
  return ranked.slice(0, n).map((r) => r.product)
}

function perProductScore(
  productId: string,
  queries: ScoringQuery[],
  byQuery: Record<string, boolean>,
): number {
  let matched = 0
  let total = 0
  for (const q of queries) {
    if (!q.targetProductIds?.includes(productId)) continue
    total += 1
    if (byQuery[q.id]) matched += 1
  }
  return total === 0 ? 0 : (matched / total) * 100
}

function classify(meanCv: number): { verdict: ScoreStabilityVerdict; message: string } {
  if (!Number.isFinite(meanCv)) {
    return { verdict: 'unknown', message: 'Insufficient data to classify stability.' }
  }
  if (meanCv < 0.05) {
    return {
      verdict: 'stable',
      message: '✓ Scoring is stable — majority voting is denoising effectively.',
    }
  }
  if (meanCv < 0.15) {
    return {
      verdict: 'moderate',
      message: '⚠ Moderate variance — consider increasing SHELF_QUERIES_PER_MEASUREMENT.',
    }
  }
  return {
    verdict: 'unstable',
    message: '✗ High variance — scores are unreliable at current measurement settings.',
  }
}

export async function computeScoreStability(input: StabilityInput): Promise<ScoreStabilityReport> {
  const runs = input.runs ?? DEFAULT_RUNS
  const productCount = input.productCount ?? DEFAULT_PRODUCTS
  const selected = pickProducts(input.products, input.queries, productCount)

  if (selected.length === 0 || input.queries.length === 0) {
    return {
      performed: true,
      reason: 'No targeted queries available — cannot measure per-product stability.',
      rows: [],
      meanCoefficientOfVariation: 0,
      verdict: 'unknown',
      verdictMessage: 'Stability analysis skipped: no queries with targetProductIds.',
      runsPerProduct: runs,
    }
  }

  // Subset the query set to ones that target at least one selected product
  // to keep API spend proportional to the products we care about.
  const selectedIds = new Set(selected.map((p) => p.id))
  const focusedQueries = input.queries.filter((q) =>
    (q.targetProductIds ?? []).some((id) => selectedIds.has(id)),
  )

  const perProductScores = new Map<string, number[]>()
  for (const p of selected) perProductScores.set(p.id, [])

  for (let run = 0; run < runs; run++) {
    input.onRun?.(run + 1, runs)
    const result = await measureScore(focusedQueries, input.storeDomain, input.providers, {
      repetitions: input.repetitions ?? 3,
    })
    for (const p of selected) {
      const s = perProductScore(p.id, focusedQueries, result.byQuery)
      perProductScores.get(p.id)?.push(s)
    }
  }

  const rows: ScoreStabilityProductRow[] = selected.map((p) => {
    const scores = perProductScores.get(p.id) ?? []
    const m = mean(scores)
    const sd = stdDev(scores)
    const cv = m === 0 ? 0 : sd / m
    return {
      productId: p.id,
      productTitle: p.title,
      scores,
      mean: m,
      stdDev: sd,
      coefficientOfVariation: cv,
      min: scores.length === 0 ? 0 : Math.min(...scores),
      max: scores.length === 0 ? 0 : Math.max(...scores),
    }
  })

  const cvs = rows.map((r) => r.coefficientOfVariation).filter((cv) => Number.isFinite(cv))
  const meanCv = cvs.length === 0 ? Number.NaN : mean(cvs)
  const { verdict, message } = classify(meanCv)

  return {
    performed: true,
    rows,
    meanCoefficientOfVariation: Number.isFinite(meanCv) ? meanCv : 0,
    verdict,
    verdictMessage: message,
    runsPerProduct: runs,
  }
}

export function emptyStabilityReport(reason: string): ScoreStabilityReport {
  return {
    performed: false,
    reason,
    rows: [],
    meanCoefficientOfVariation: 0,
    verdict: 'unknown',
    verdictMessage: reason,
    runsPerProduct: 0,
  }
}
