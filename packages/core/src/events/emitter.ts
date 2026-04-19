import { EventEmitter } from 'node:events'
import type { ConfidenceLevel } from '../confidence/mad.js'
import type { ApplyResult, Hypothesis } from '../hypothesis/types.js'
import type { ExperimentLog } from '../logger/jsonl.js'

// Every event carries these baseline telemetry fields so a dashboard can
// render a consistent status line without special-casing event types.
export interface EventBase {
  iteration: number
  elapsedMs: number
  costUsd: number
  productId?: string
  scoreDelta: number
  confidence: ConfidenceLevel
}

export type ShelfEvent =
  | (EventBase & {
      type: 'session:start'
      baselineScore: number
      queriesCount: number
      productsCount: number
      maxIterations: number
      budgetLimitUsd: number
    })
  | (EventBase & {
      type: 'hypothesis:proposed'
      productId: string
      hypothesis: Hypothesis
    })
  | (EventBase & {
      type: 'checks:failed'
      productId: string
      hypothesisId: string
      failures: string[]
    })
  | (EventBase & {
      type: 'hypothesis:applied'
      productId: string
      hypothesisId: string
      applyResult: ApplyResult
    })
  | (EventBase & {
      type: 'measurement:complete'
      productId: string
      scoreBefore: number
      scoreAfter: number
    })
  | (EventBase & {
      type: 'experiment:kept'
      productId: string
      log: ExperimentLog
    })
  | (EventBase & {
      type: 'experiment:reverted'
      productId: string
      log: ExperimentLog
    })
  | (EventBase & {
      type: 'experiment:kept_uncertain'
      productId: string
      log: ExperimentLog
    })
  | (EventBase & {
      type: 'budget:warning'
      cumulativeCostUsd: number
      limitUsd: number
      remainingUsd: number
    })
  | (EventBase & {
      type: 'session:end'
      finalScore: number
      baselineScore: number
      totalIterations: number
      totalCostUsd: number
      stopReason: string
    })

export type ShelfEventType = ShelfEvent['type']

type TypedHandler<T extends ShelfEventType> = (event: Extract<ShelfEvent, { type: T }>) => void
type AnyHandler = (event: ShelfEvent) => void

const WILDCARD = '*'

export class ShelfEventEmitter {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  emit(event: ShelfEvent): void {
    this.emitter.emit(event.type, event)
    this.emitter.emit(WILDCARD, event)
  }

  on<T extends ShelfEventType>(type: T, handler: TypedHandler<T>): () => void {
    const wrapped = (event: ShelfEvent): void => {
      handler(event as Extract<ShelfEvent, { type: T }>)
    }
    this.emitter.on(type, wrapped)
    return () => this.emitter.off(type, wrapped)
  }

  onAny(handler: AnyHandler): () => void {
    this.emitter.on(WILDCARD, handler)
    return () => this.emitter.off(WILDCARD, handler)
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners()
  }
}
