import type { ExperimentLog } from '../logger/jsonl.js'
import { computeHypothesisEffectiveness } from './hypothesis-effectiveness.js'
import { computePlateau } from './plateau.js'
import { computeProviderDisagreement } from './provider-disagreement.js'
import { computeRewardHacking } from './reward-hacking.js'
import { buildSummary } from './report.js'
import type { EvalReport, ScoreStabilityReport } from './types.js'

export interface BuildEvalReportInput {
  logs: ExperimentLog[]
  storeDomain: string
  jsonlPath: string
  scoreStability: ScoreStabilityReport
  generatedAt?: string
}

export function buildEvalReport(input: BuildEvalReportInput): EvalReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const hypothesisEffectiveness = computeHypothesisEffectiveness(input.logs)
  const plateau = computePlateau(input.logs)
  const providerDisagreement = computeProviderDisagreement(input.logs)
  const rewardHacking = computeRewardHacking(input.logs)

  const partial: Omit<EvalReport, 'summary'> = {
    generatedAt,
    storeDomain: input.storeDomain,
    jsonlPath: input.jsonlPath,
    totalExperiments: input.logs.length,
    hypothesisEffectiveness,
    scoreStability: input.scoreStability,
    plateau,
    providerDisagreement,
    rewardHacking,
  }

  const summary = buildSummary(partial)
  return { ...partial, summary }
}
