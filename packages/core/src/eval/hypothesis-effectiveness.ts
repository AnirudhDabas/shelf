import type { HypothesisType } from '../hypothesis/types.js'
import type { ExperimentLog, Verdict } from '../logger/jsonl.js'
import type {
  HypothesisEffectivenessReport,
  HypothesisEffectivenessRow,
} from './types.js'

const ALL_TYPES: HypothesisType[] = [
  'title_rewrite',
  'description_restructure',
  'metafield_add',
  'metafield_update',
  'seo_title',
  'seo_description',
  'tags_update',
]

const ALL_VERDICTS: Verdict[] = [
  'kept',
  'reverted',
  'kept_uncertain',
  'checks_failed',
  'generator_failed',
  'apply_failed',
  'measure_failed',
]

function isKept(v: Verdict): boolean {
  return v === 'kept' || v === 'kept_uncertain'
}

function isReverted(v: Verdict): boolean {
  return v === 'reverted'
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function computeHypothesisEffectiveness(
  logs: ExperimentLog[],
): HypothesisEffectivenessReport {
  const ordered = [...logs].sort((a, b) => a.iteration - b.iteration)
  const byType = new Map<HypothesisType, ExperimentLog[]>()
  for (const t of ALL_TYPES) byType.set(t, [])
  for (const l of ordered) {
    const bucket = byType.get(l.hypothesis.type)
    if (bucket) bucket.push(l)
  }

  const rows: HypothesisEffectivenessRow[] = []
  for (const type of ALL_TYPES) {
    const entries = byType.get(type) ?? []
    if (entries.length === 0) continue

    const kept = entries.filter((e) => isKept(e.verdict))
    const reverted = entries.filter((e) => isReverted(e.verdict))
    const total = entries.length

    // Iterations to first keep, computed per product so a single product
    // dragging the type's median doesn't dominate when other products land
    // their first kept hypothesis quickly.
    const firstKeepByProduct = new Map<string, number>()
    const firstAttemptByProduct = new Map<string, number>()
    for (const e of entries) {
      const pid = e.hypothesis.productId
      if (!firstAttemptByProduct.has(pid)) firstAttemptByProduct.set(pid, e.iteration)
      if (isKept(e.verdict) && !firstKeepByProduct.has(pid)) {
        firstKeepByProduct.set(pid, e.iteration)
      }
    }
    const itersToFirstKeep: number[] = []
    for (const [pid, keepIter] of firstKeepByProduct) {
      const start = firstAttemptByProduct.get(pid) ?? keepIter
      itersToFirstKeep.push(Math.max(1, keepIter - start + 1))
    }

    const avgKeptDelta = mean(kept.map((e) => e.scoreDelta))
    const avgRevertedDelta = mean(reverted.map((e) => e.scoreDelta))
    const keepRate = total === 0 ? 0 : kept.length / total
    const expectedValuePerAttempt = keepRate * avgKeptDelta

    rows.push({
      type,
      total,
      kept: kept.length,
      reverted: reverted.length,
      keepRate,
      avgScoreDeltaKept: avgKeptDelta,
      avgScoreDeltaReverted: avgRevertedDelta,
      medianIterationsToFirstKeep: median(itersToFirstKeep),
      expectedValuePerAttempt,
    })
  }

  rows.sort((a, b) => b.keepRate - a.keepRate || b.avgScoreDeltaKept - a.avgScoreDeltaKept)

  // Priority ranks by expected delta per attempt: a 50% keep rate with
  // +5 score delta beats a 100% keep rate with +1.
  const priorityOrder = [...rows]
    .filter((r) => r.kept > 0)
    .sort((a, b) => b.expectedValuePerAttempt - a.expectedValuePerAttempt)
    .map((r) => r.type)

  const byVerdict: Record<Verdict, number> = ALL_VERDICTS.reduce(
    (acc, v) => {
      acc[v] = 0
      return acc
    },
    {} as Record<Verdict, number>,
  )
  for (const l of logs) byVerdict[l.verdict] = (byVerdict[l.verdict] ?? 0) + 1

  const totalKept = logs.filter((l) => isKept(l.verdict)).length
  const totalReverted = logs.filter((l) => isReverted(l.verdict)).length

  return {
    rows,
    priorityOrder,
    totalExperiments: logs.length,
    totalKept,
    totalReverted,
    byVerdict,
  }
}
