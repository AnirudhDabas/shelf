export type HypothesisType =
  | 'title_rewrite'
  | 'description_restructure'
  | 'metafield_add'
  | 'metafield_update'
  | 'seo_title'
  | 'seo_description'
  | 'tags_update'

export type HypothesisLevel = 'low' | 'medium' | 'high'

export interface Hypothesis {
  id: string
  type: HypothesisType
  productId: string
  productTitle: string
  field: string
  before: string
  after: string
  description: string
  reasoning: string
  queryFailurePatterns: string[]
  predictedEffect: string
  riskLevel: HypothesisLevel
  confidence: HypothesisLevel
  estimatedImpact: string
  promptVersion: string
  metafieldNamespace?: string
  metafieldKey?: string
  metafieldType?: string
}

export interface FieldChange {
  field: string
  oldValue: string
  newValue: string
}

export interface ApplyResult {
  hypothesisId: string
  type: HypothesisType
  productId: string
  metafieldNamespace?: string
  metafieldKey?: string
  metafieldType?: string
  changes: FieldChange[]
  response: unknown
  appliedAt: string
}

export interface RevertResult {
  hypothesisId: string
  productId: string
  restoredChanges: FieldChange[]
  response: unknown
  revertedAt: string
}
