import type { HypothesisType } from '../hypothesis/types.js'
import type { Verdict } from '../logger/jsonl.js'

export interface HypothesisEffectivenessRow {
  type: HypothesisType
  total: number
  kept: number
  reverted: number
  keepRate: number
  avgScoreDeltaKept: number
  avgScoreDeltaReverted: number
  medianIterationsToFirstKeep: number | null
  expectedValuePerAttempt: number
}

export interface HypothesisEffectivenessReport {
  rows: HypothesisEffectivenessRow[]
  // Recommended priority order if a merchant only had budget for ~10 iterations.
  priorityOrder: HypothesisType[]
  totalExperiments: number
  totalKept: number
  totalReverted: number
  byVerdict: Record<Verdict, number>
}

export interface ScoreStabilityProductRow {
  productId: string
  productTitle: string
  scores: number[]
  mean: number
  stdDev: number
  coefficientOfVariation: number
  min: number
  max: number
}

export type ScoreStabilityVerdict = 'stable' | 'moderate' | 'unstable' | 'unknown'

export interface ScoreStabilityReport {
  performed: boolean
  reason?: string
  rows: ScoreStabilityProductRow[]
  meanCoefficientOfVariation: number
  verdict: ScoreStabilityVerdict
  verdictMessage: string
  runsPerProduct: number
}

export interface PlateauPoint {
  iteration: number
  score: number
  delta: number
  rollingPositiveAvg: number | null
}

export interface PlateauReport {
  series: PlateauPoint[]
  baselineScore: number
  finalScore: number
  totalIterations: number
  plateauIteration: number | null
  plateauScore: number | null
  cumulativeCostUsd: number
  costPerScorePoint: number | null
  verdict: string
}

export interface ProviderDisagreementReport {
  available: boolean
  reason?: string
  providers: string[]
  perProviderKeepRate: Record<string, number>
  perProviderScoreTrajectory: Record<string, Array<{ iteration: number; score: number }>>
  disagreementRate: number
  divergentProviders: string[]
  verdict: string
}

export type RewardHackingRisk = 'low' | 'medium' | 'high' | 'unknown'

export interface RewardHackingTrendSample {
  iteration: number
  value: number
}

export interface RewardHackingReport {
  available: boolean
  reason?: string
  titleLengthSeries: RewardHackingTrendSample[]
  titleLengthSlope: number
  descriptionGradeSeries: RewardHackingTrendSample[]
  descriptionGradeSlope: number
  keywordDensitySeries: RewardHackingTrendSample[]
  keywordDensitySlope: number
  productCoverage: {
    keptExperiments: number
    uniqueProducts: number
    topProductShare: number
    diversityRatio: number
  }
  signals: string[]
  risk: RewardHackingRisk
  verdict: string
}

export interface EvalReport {
  generatedAt: string
  storeDomain: string
  jsonlPath: string
  totalExperiments: number
  hypothesisEffectiveness: HypothesisEffectivenessReport
  scoreStability: ScoreStabilityReport
  plateau: PlateauReport
  providerDisagreement: ProviderDisagreementReport
  rewardHacking: RewardHackingReport
  summary: string
}
