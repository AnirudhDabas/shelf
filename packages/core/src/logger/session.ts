import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface KeyWin {
  iteration: number
  productId: string
  productTitle: string
  description: string
  scoreDelta: number
}

export interface DeadEnd {
  iteration: number
  productId: string
  productTitle: string
  description: string
  reason: string
}

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
  objective: string
  triedCount: number
  keyWins: KeyWin[]
  deadEnds: DeadEnd[]
}

// The session markdown follows pi-autoresearch's living-document pattern:
// a fresh agent should be able to resume from shelf.md alone. Required
// sections: Objective, Status, Key wins, What's been tried, Dead ends.
// A fenced JSON block carries the machine-parseable state for programmatic
// resume.
const STATE_FENCE = 'shelf-session'
const FENCE_RE = /```shelf-session\n([\s\S]*?)```/m
const MAX_RENDERED_WINS = 10
const MAX_RENDERED_DEADENDS = 10

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

  start(init: { baselineScore: number; objective?: string }): SessionState {
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
      objective:
        init.objective ??
        `Raise the AI Shelf Score from baseline ${init.baselineScore.toFixed(1)}/100 through autonomous catalog optimization.`,
      triedCount: 0,
      keyWins: [],
      deadEnds: [],
    }
    this.current = state
    this.persist()
    return state
  }

  update(patch: Partial<SessionState>): SessionState {
    const state = this.require()
    const next: SessionState = {
      ...state,
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

  setObjective(objective: string): void {
    const state = this.require()
    this.current = { ...state, objective, updatedAt: new Date().toISOString() }
    this.persist()
  }

  recordProductTouched(productId: string): void {
    const state = this.require()
    if (state.productsTouched.includes(productId)) return
    this.current = {
      ...state,
      productsTouched: [...state.productsTouched, productId],
      updatedAt: new Date().toISOString(),
    }
    this.persist()
  }

  recordAttempt(): void {
    const state = this.require()
    this.current = {
      ...state,
      triedCount: state.triedCount + 1,
      updatedAt: new Date().toISOString(),
    }
    this.persist()
  }

  recordKeyWin(win: KeyWin): void {
    const state = this.require()
    this.current = {
      ...state,
      keyWins: [...state.keyWins, win],
      updatedAt: new Date().toISOString(),
    }
    this.persist()
  }

  recordDeadEnd(deadEnd: DeadEnd): void {
    const state = this.require()
    this.current = {
      ...state,
      deadEnds: [...state.deadEnds, deadEnd],
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
      this.current = JSON.parse(match[1]) as SessionState
      return this.current
    } catch {
      return null
    }
  }

  reset(): void {
    this.current = null
    if (existsSync(this.path)) writeFileSync(this.path, '', 'utf-8')
  }

  private require(): SessionState {
    if (!this.current) {
      throw new Error('SessionLogger: start() must be called before mutation')
    }
    return this.current
  }

  private persist(): void {
    if (!this.current) return
    writeFileSync(this.path, renderMarkdown(this.current), 'utf-8')
  }
}

function renderMarkdown(state: SessionState): string {
  const delta = state.currentScore - state.baselineScore
  const sign = delta >= 0 ? '+' : ''
  const recentWins = state.keyWins.slice(-MAX_RENDERED_WINS).reverse()
  const recentDeadEnds = state.deadEnds.slice(-MAX_RENDERED_DEADENDS).reverse()

  const winsBlock = recentWins.length
    ? recentWins
        .map(
          (w) =>
            `- iter ${w.iteration} · **${w.productTitle}** — ${w.description} (+${w.scoreDelta.toFixed(2)})`,
        )
        .join('\n')
    : '_No kept changes yet._'

  const deadBlock = recentDeadEnds.length
    ? recentDeadEnds
        .map(
          (d) =>
            `- iter ${d.iteration} · **${d.productTitle}** — ${d.description} _(${d.reason})_`,
        )
        .join('\n')
    : '_No dead ends yet._'

  const triedSummary = state.triedCount
    ? `${state.triedCount} hypotheses attempted across ${state.productsTouched.length} kept product(s).`
    : 'No hypotheses attempted yet.'

  const lines = [
    '# shelf session',
    '',
    `\`\`\`${STATE_FENCE}`,
    JSON.stringify(state, null, 2),
    '```',
    '',
    '## Objective',
    '',
    state.objective,
    '',
    '## Status',
    '',
    `- Score: **${state.currentScore.toFixed(1)}** (baseline ${state.baselineScore.toFixed(1)}, best ${state.bestScore.toFixed(1)}, ${sign}${delta.toFixed(1)})`,
    `- Iteration: ${state.iteration}`,
    `- Products kept: ${state.productsTouched.length}`,
    `- Elapsed: ${formatDuration(state.elapsedMs)}`,
    `- Cost: $${state.cumulativeCostUsd.toFixed(4)}`,
    `- Started: ${state.startedAt}`,
    `- Updated: ${state.updatedAt}`,
  ]
  if (state.ended) {
    lines.push(`- Status: ended${state.stopReason ? ` (${state.stopReason})` : ''}`)
  }
  lines.push('', '## Key wins', '', winsBlock)
  lines.push('', "## What's been tried", '', triedSummary)
  lines.push('', '## Dead ends', '', deadBlock, '')
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
