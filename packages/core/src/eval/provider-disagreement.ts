import type { ExperimentLog } from '../logger/jsonl.js'
import type { ProviderDisagreementReport } from './types.js'

interface PerProviderScore {
  iteration: number
  score: number
}

interface ExtendedExperiment extends ExperimentLog {
  byProvider?: Record<string, number>
  perProviderVerdict?: Record<string, 'kept' | 'reverted'>
}

// Per-experiment provider data isn't part of the canonical ExperimentLog
// shape today (the loop logs only the aggregated overall score). We still
// run the analysis so future log shapes light it up automatically — when
// the data is missing we degrade to an availability note.
export function computeProviderDisagreement(
  logs: ExperimentLog[],
): ProviderDisagreementReport {
  const enriched = logs as ExtendedExperiment[]
  const withProviderData = enriched.filter(
    (l) => l.byProvider && Object.keys(l.byProvider).length > 0,
  )

  if (withProviderData.length === 0) {
    return {
      available: false,
      reason:
        'No per-provider scoring breakdown found in shelf.jsonl. Provider disagreement requires logs to include `byProvider` per experiment.',
      providers: [],
      perProviderKeepRate: {},
      perProviderScoreTrajectory: {},
      disagreementRate: 0,
      divergentProviders: [],
      verdict: 'Per-provider analysis skipped — data unavailable.',
    }
  }

  const providers = new Set<string>()
  for (const l of withProviderData) {
    for (const p of Object.keys(l.byProvider ?? {})) providers.add(p)
  }
  const providerList = [...providers].sort()

  const perProviderTrajectory: Record<string, PerProviderScore[]> = {}
  const perProviderKept: Record<string, number> = {}
  const perProviderTotal: Record<string, number> = {}
  for (const name of providerList) {
    perProviderTrajectory[name] = []
    perProviderKept[name] = 0
    perProviderTotal[name] = 0
  }

  let disagreements = 0
  for (const l of withProviderData.sort((a, b) => a.iteration - b.iteration)) {
    const verdicts: Record<string, 'kept' | 'reverted'> = l.perProviderVerdict ?? {}
    const seen: Array<'kept' | 'reverted'> = []
    for (const name of providerList) {
      const score = l.byProvider?.[name]
      if (score !== undefined) {
        perProviderTrajectory[name].push({ iteration: l.iteration, score })
      }
      const v = verdicts[name]
      if (v) {
        perProviderTotal[name] += 1
        if (v === 'kept') perProviderKept[name] += 1
        seen.push(v)
      }
    }
    if (seen.length >= 2 && new Set(seen).size > 1) disagreements += 1
  }

  const perProviderKeepRate: Record<string, number> = {}
  for (const name of providerList) {
    const total = perProviderTotal[name]
    perProviderKeepRate[name] = total === 0 ? 0 : perProviderKept[name] / total
  }

  const finalScores: Array<{ name: string; score: number }> = providerList
    .map((name) => {
      const series = perProviderTrajectory[name]
      const last = series[series.length - 1]
      return { name, score: last ? last.score : 0 }
    })
    .filter((s) => Number.isFinite(s.score))

  const divergent: string[] = []
  if (finalScores.length >= 2) {
    const overallMean = finalScores.reduce((s, p) => s + p.score, 0) / finalScores.length
    for (const f of finalScores) {
      if (Math.abs(f.score - overallMean) > 15) divergent.push(f.name)
    }
  }

  const disagreementRate =
    withProviderData.length === 0 ? 0 : disagreements / withProviderData.length

  let verdict: string
  if (divergent.length > 0) {
    verdict = `${divergent.join('/')} score${divergent.length === 1 ? 's' : ''} diverge from the rest — your catalog may need provider-specific optimization.`
  } else if (disagreementRate > 0.3) {
    verdict = `Providers disagreed on ${(disagreementRate * 100).toFixed(0)}% of experiments — high variance across providers.`
  } else {
    verdict = 'Providers are largely aligned on which changes to keep.'
  }

  return {
    available: true,
    providers: providerList,
    perProviderKeepRate,
    perProviderScoreTrajectory: perProviderTrajectory,
    disagreementRate,
    divergentProviders: divergent,
    verdict,
  }
}
