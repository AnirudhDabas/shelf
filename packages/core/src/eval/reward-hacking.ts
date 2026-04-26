import type { ExperimentLog } from '../logger/jsonl.js'
import type {
  RewardHackingReport,
  RewardHackingRisk,
  RewardHackingTrendSample,
} from './types.js'

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'for', 'to', 'of', 'in',
  'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'your',
  'our', 'you', 'we', 'they', 'them', 'us', 'so', 'not', 'no', 'can', 'will',
  'has', 'have', 'had', 'do', 'does', 'did', 'up', 'down', 'out', 'over',
  'more', 'most', 'some', 'any',
])

function isKept(v: ExperimentLog['verdict']): boolean {
  return v === 'kept' || v === 'kept_uncertain'
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function fleschKincaidGrade(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?]+/g) ?? []).length)
  const words = text.match(/[A-Za-z]+/g) ?? []
  if (words.length === 0) return 0
  let syllables = 0
  for (const w of words) syllables += syllableCount(w)
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59
}

function syllableCount(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.length === 0) return 0
  if (w.length <= 3) return 1
  let trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
  trimmed = trimmed.replace(/^y/, '')
  const groups = trimmed.match(/[aeiouy]+/g)
  return Math.max(1, groups?.length ?? 0)
}

function maxKeywordCount(text: string): number {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const counts = new Map<string, number>()
  for (const w of words) {
    if (w.length < 3) continue
    if (STOP_WORDS.has(w)) continue
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  let max = 0
  for (const c of counts.values()) {
    if (c > max) max = c
  }
  return max
}

// Linear regression slope across (iteration, value) pairs. Used to detect
// monotonic creep — a positive slope on title length means kept changes
// are stuffing titles longer over time.
function linearSlope(samples: RewardHackingTrendSample[]): number {
  const n = samples.length
  if (n < 2) return 0
  const meanX = samples.reduce((s, p) => s + p.iteration, 0) / n
  const meanY = samples.reduce((s, p) => s + p.value, 0) / n
  let num = 0
  let den = 0
  for (const p of samples) {
    const dx = p.iteration - meanX
    num += dx * (p.value - meanY)
    den += dx * dx
  }
  return den === 0 ? 0 : num / den
}

interface FieldChangeLike {
  field: string
  newValue: string
}

function changesFor(log: ExperimentLog): FieldChangeLike[] {
  return log.applyResult?.changes ?? []
}

export function computeRewardHacking(logs: ExperimentLog[]): RewardHackingReport {
  const kept = logs
    .filter((l) => isKept(l.verdict))
    .sort((a, b) => a.iteration - b.iteration)

  if (kept.length === 0) {
    return {
      available: false,
      reason: 'No kept experiments in shelf.jsonl — nothing to audit.',
      titleLengthSeries: [],
      titleLengthSlope: 0,
      descriptionGradeSeries: [],
      descriptionGradeSlope: 0,
      keywordDensitySeries: [],
      keywordDensitySlope: 0,
      productCoverage: {
        keptExperiments: 0,
        uniqueProducts: 0,
        topProductShare: 0,
        diversityRatio: 0,
      },
      signals: [],
      risk: 'unknown',
      verdict: 'Reward-hacking audit skipped — no kept experiments.',
    }
  }

  const titleLengthSeries: RewardHackingTrendSample[] = []
  const descriptionGradeSeries: RewardHackingTrendSample[] = []
  const keywordDensitySeries: RewardHackingTrendSample[] = []

  for (const log of kept) {
    for (const change of changesFor(log)) {
      if (change.field === 'title') {
        titleLengthSeries.push({ iteration: log.iteration, value: change.newValue.length })
        keywordDensitySeries.push({
          iteration: log.iteration,
          value: maxKeywordCount(change.newValue),
        })
      } else if (change.field === 'descriptionHtml') {
        const text = stripHtml(change.newValue)
        if (text.length > 0) {
          descriptionGradeSeries.push({
            iteration: log.iteration,
            value: fleschKincaidGrade(text),
          })
          keywordDensitySeries.push({
            iteration: log.iteration,
            value: maxKeywordCount(text),
          })
        }
      }
    }
  }

  const productCounts = new Map<string, number>()
  for (const log of kept) {
    const pid = log.hypothesis.productId
    productCounts.set(pid, (productCounts.get(pid) ?? 0) + 1)
  }
  const uniqueProducts = productCounts.size
  const topProductCount = [...productCounts.values()].reduce(
    (max, v) => (v > max ? v : max),
    0,
  )
  const topProductShare = kept.length === 0 ? 0 : topProductCount / kept.length
  const diversityRatio = kept.length === 0 ? 0 : uniqueProducts / kept.length

  const titleLengthSlope = linearSlope(titleLengthSeries)
  const descriptionGradeSlope = linearSlope(descriptionGradeSeries)
  const keywordDensitySlope = linearSlope(keywordDensitySeries)

  const signals: string[] = []
  if (titleLengthSlope > 0.5 && titleLengthSeries.length >= 3) {
    signals.push(
      `title length growing ~${titleLengthSlope.toFixed(2)} chars/iter across kept rewrites`,
    )
  }
  if (descriptionGradeSlope > 0.05 && descriptionGradeSeries.length >= 3) {
    signals.push(
      `description grade rising ~${descriptionGradeSlope.toFixed(3)}/iter — descriptions getting denser`,
    )
  }
  if (keywordDensitySlope > 0.05 && keywordDensitySeries.length >= 3) {
    signals.push(
      `max keyword count drifting up ~${keywordDensitySlope.toFixed(3)}/iter`,
    )
  }
  if (topProductShare > 0.5 && kept.length >= 4) {
    signals.push(
      `${(topProductShare * 100).toFixed(0)}% of kept changes cluster on a single product`,
    )
  }
  if (diversityRatio < 0.3 && kept.length >= 5) {
    signals.push(
      `low diversity — only ${uniqueProducts} unique products across ${kept.length} kept changes`,
    )
  }

  let risk: RewardHackingRisk
  if (signals.length >= 3) risk = 'high'
  else if (signals.length >= 1) risk = 'medium'
  else risk = 'low'

  let verdict: string
  if (risk === 'high') {
    verdict = 'High risk — multiple stuffing/clustering signals firing. Inspect kept changes manually.'
  } else if (risk === 'medium') {
    verdict = 'Medium risk — at least one creep signal worth investigating.'
  } else {
    verdict = 'Low risk — kept changes look balanced across products and within readability bounds.'
  }

  return {
    available: true,
    titleLengthSeries,
    titleLengthSlope,
    descriptionGradeSeries,
    descriptionGradeSlope,
    keywordDensitySeries,
    keywordDensitySlope,
    productCoverage: {
      keptExperiments: kept.length,
      uniqueProducts,
      topProductShare,
      diversityRatio,
    },
    signals,
    risk,
    verdict,
  }
}
