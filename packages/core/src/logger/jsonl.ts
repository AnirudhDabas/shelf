import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ConfidenceLevel } from '../confidence/mad.js'
import type { ApplyResult, Hypothesis, RevertResult } from '../hypothesis/types.js'

export type Verdict =
  | 'kept'
  | 'reverted'
  | 'kept_uncertain'
  | 'checks_failed'
  | 'generator_failed'
  | 'apply_failed'
  | 'measure_failed'

export interface ExperimentLog {
  id: string
  iteration: number
  timestamp: string
  hypothesis: Hypothesis
  verdict: Verdict
  scoreBefore: number
  scoreAfter: number
  scoreDelta: number
  confidence: number
  confidenceLevel: ConfidenceLevel
  durationMs: number
  costEstimateUsd: number
  failures?: string[]
  error?: string
  applyResult?: ApplyResult
  revertResult?: RevertResult
}

export class JsonlLogger {
  private path: string

  constructor(path: string) {
    this.path = resolve(process.cwd(), path)
  }

  get filePath(): string {
    return this.path
  }

  append(entry: ExperimentLog): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf-8')
  }

  readAll(): ExperimentLog[] {
    if (!existsSync(this.path)) return []
    const raw = readFileSync(this.path, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    const entries: ExperimentLog[] = []
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as ExperimentLog)
      } catch {
        // Skip malformed lines rather than crash the loop on resume.
      }
    }
    return entries
  }

  reset(): void {
    if (existsSync(this.path)) writeFileSync(this.path, '', 'utf-8')
  }
}
