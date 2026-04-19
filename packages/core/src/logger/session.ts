import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface SessionState {
  startedAt: string
  updatedAt: string
  iteration: number
  baselineScore: number
  currentScore: number
  bestScore: number
  productsTouched: string[]
  cumulativeCostUsd: number
  elapsedMs: number
  ended: boolean
  stopReason?: string
}

// The markdown file is the human-readable view. A fenced JSON block near the
// top carries the machine-parseable state so the loop can resume cleanly on
// restart without needing a separate sidecar file.
const STATE_FENCE = 'shelf-session'
const FENCE_RE = /```shelf-session\n([\s\S]*?)```/m

export class SessionLogger {
  private path: string
  private current: SessionState | null = null

  constructor(path: string) {
    this.path = resolve(process.cwd(), path)
  }

  get filePath(): string {
    return this.path
  }

  get state(): SessionState | null {
    return this.current
  }

  start(init: { baselineScore: number }): SessionState {
    const now = new Date().toISOString()
    const state: SessionState = {
      startedAt: now,
      updatedAt: now,
      iteration: 0,
      baselineScore: init.baselineScore,
      currentScore: init.baselineScore,
      bestScore: init.baselineScore,
      productsTouched: [],
      cumulativeCostUsd: 0,
      elapsedMs: 0,
      ended: false,
    }
    this.current = state
    this.persist()
    return state
  }

  update(patch: Partial<SessionState>): SessionState {
    if (!this.current) {
      throw new Error('SessionLogger: start() must be called before update()')
    }
    const next: SessionState = {
      ...this.current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    if (patch.currentScore !== undefined && patch.currentScore > next.bestScore) {
      next.bestScore = patch.currentScore
    }
    this.current = next
    this.persist()
    return next
  }

  recordProductTouched(productId: string): void {
    if (!this.current) return
    if (this.current.productsTouched.includes(productId)) return
    this.current = {
      ...this.current,
      productsTouched: [...this.current.productsTouched, productId],
      updatedAt: new Date().toISOString(),
    }
    this.persist()
  }

  end(finalScore: number, reason: string): SessionState {
    return this.update({ currentScore: finalScore, ended: true, stopReason: reason })
  }

  load(): SessionState | null {
    if (!existsSync(this.path)) return null
    const raw = readFileSync(this.path, 'utf-8')
    const match = raw.match(FENCE_RE)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[1]) as SessionState
      this.current = parsed
      return parsed
    } catch {
      return null
    }
  }

  reset(): void {
    this.current = null
    if (existsSync(this.path)) writeFileSync(this.path, '', 'utf-8')
  }

  private persist(): void {
    if (!this.current) return
    writeFileSync(this.path, renderMarkdown(this.current), 'utf-8')
  }
}

function renderMarkdown(state: SessionState): string {
  const delta = state.currentScore - state.baselineScore
  const sign = delta >= 0 ? '+' : ''
  const lines = [
    '# shelf session',
    '',
    `\`\`\`${STATE_FENCE}`,
    JSON.stringify(state, null, 2),
    '```',
    '',
    '## Status',
    '',
    `- Score: **${state.currentScore.toFixed(1)}** (baseline ${state.baselineScore.toFixed(1)}, best ${state.bestScore.toFixed(1)}, ${sign}${delta.toFixed(1)})`,
    `- Iteration: ${state.iteration}`,
    `- Products touched: ${state.productsTouched.length}`,
    `- Elapsed: ${formatDuration(state.elapsedMs)}`,
    `- Cost: $${state.cumulativeCostUsd.toFixed(4)}`,
    `- Started: ${state.startedAt}`,
    `- Updated: ${state.updatedAt}`,
  ]
  if (state.ended) {
    lines.push(`- Status: ended${state.stopReason ? ` (${state.stopReason})` : ''}`)
  }
  lines.push('')
  return lines.join('\n')
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}
