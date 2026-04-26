export type { ShelfConfig, LoadConfigOverrides } from './config.js'
export { loadConfig, ConfigError } from './config.js'

export { runLoop } from './loop.js'
export type { RunLoopDependencies } from './loop.js'

export {
  measureScore,
  buildProviders,
  AnthropicScorer,
  OpenAIScorer,
  PerplexityScorer,
} from './scorer/index.js'
export type {
  AggregatedScore,
  ScoringProvider,
  ScoringQuery,
  ScoringResult,
  ProviderName,
  MeasureOptions,
  BuildProvidersOptions,
} from './scorer/index.js'

export { ShopifyAdminClient, fetchAccessToken } from './shopify/admin.js'
export type { ShopifyProduct, ShopifyVariant } from './shopify/types.js'

export {
  HypothesisGenerator,
  HypothesisApplier,
  HypothesisReverter,
  HypothesisValidationError,
  HypothesisApplyError,
  HypothesisRevertError,
} from './hypothesis/index.js'
export type {
  Hypothesis,
  HypothesisType,
  HypothesisLevel,
  ApplyResult,
  RevertResult,
  FieldChange,
} from './hypothesis/types.js'

export { QueryGenerator, QueryValidationError } from './queries/generator.js'

export { checkHypothesis } from './checks/backpressure.js'
export type { BackpressureResult } from './checks/backpressure.js'

export { computeConfidence, median, medianAbsoluteDeviation } from './confidence/mad.js'
export type { ConfidenceLevel, ConfidenceResult } from './confidence/mad.js'

export { JsonlLogger } from './logger/jsonl.js'
export type { ExperimentLog, Verdict } from './logger/jsonl.js'

export { SessionLogger } from './logger/session.js'
export type { SessionState, KeyWin, DeadEnd } from './logger/session.js'

export { ShelfEventEmitter } from './events/emitter.js'
export type { ShelfEvent, ShelfEventType, EventBase } from './events/emitter.js'

export { FileCache } from './utils/cache.js'
export { BudgetTracker } from './utils/cost.js'

export {
  buildEvalReport,
  computeHypothesisEffectiveness,
  computePlateau,
  computeProviderDisagreement,
  computeRewardHacking,
  computeScoreStability,
  emptyStabilityReport,
  renderMarkdown,
} from './eval/index.js'
export type {
  BuildEvalReportInput,
  EvalReport,
  HypothesisEffectivenessReport,
  HypothesisEffectivenessRow,
  PlateauPoint,
  PlateauReport,
  ProviderDisagreementReport,
  RewardHackingReport,
  RewardHackingRisk,
  ScoreStabilityProductRow,
  ScoreStabilityReport,
  ScoreStabilityVerdict,
  StabilityInput,
} from './eval/index.js'
