export interface TokenUsage {
  input: number
  output: number
}

interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
}

const PRICING: Record<string, ModelPricing> = {
  'perplexity:sonar': { inputPer1M: 1.0, outputPer1M: 1.0 },
  'openai:gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'openai:gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'anthropic:claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'anthropic:claude-haiku-4-5': { inputPer1M: 1.0, outputPer1M: 5.0 },
}

const warnedUnknownModels = new Set<string>()

// Returns 0 for unknown modelKeys so the caller's accounting doesn't blow up,
// but emits a single stderr warning per unknown key so the operator notices
// (silently dropping cost would understate budget consumption).
export function estimateCost(modelKey: string, usage: TokenUsage): number {
  const pricing = PRICING[modelKey]
  if (!pricing) {
    if (!warnedUnknownModels.has(modelKey)) {
      warnedUnknownModels.add(modelKey)
      console.warn(
        `cost: unknown modelKey "${modelKey}" — reporting $0 for this provider; add it to PRICING in utils/cost.ts`,
      )
    }
    return 0
  }
  return (usage.input / 1_000_000) * pricing.inputPer1M + (usage.output / 1_000_000) * pricing.outputPer1M
}

export class BudgetTracker {
  private limit: number
  private spent = 0

  constructor(limitUsd: number) {
    this.limit = limitUsd
  }

  add(amount: number): void {
    this.spent += amount
  }

  remaining(): number {
    return Math.max(0, this.limit - this.spent)
  }

  total(): number {
    return this.spent
  }

  exhausted(): boolean {
    return this.spent >= this.limit
  }
}
