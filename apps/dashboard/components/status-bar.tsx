'use client'
import { useEffect, useRef, useState } from 'react'
import type { ExperimentLog } from '@shelf/core'

interface StatusBarProps {
  experiments: ExperimentLog[]
  startedAt: string | null
}

export function StatusBar({ experiments, startedAt }: StatusBarProps) {
  const baseline = experiments[0]?.scoreBefore ?? 0
  const current = lastKeptScore(experiments) ?? baseline
  const delta = current - baseline
  const iteration = experiments.at(-1)?.iteration ?? 0
  const cost = experiments.reduce((sum, e) => sum + (e.costEstimateUsd ?? 0), 0)
  const productsTouched = new Set(
    experiments
      .filter((e) => e.verdict === 'kept' || e.verdict === 'kept_uncertain')
      .map((e) => e.hypothesis.productId),
  ).size

  const elapsed = useElapsed(startedAt)
  const pulse = usePulseOnKeep(experiments)

  return (
    <section className="border-b border-border bg-surface px-6 py-5">
      <div className="flex items-end justify-between gap-6 flex-wrap">
        <div className={pulse ? 'pulse-bump' : ''}>
          <div className="text-xs uppercase tracking-wider text-text-secondary">
            AI Shelf Score
          </div>
          <div className="font-mono text-6xl font-semibold tabular-nums leading-none mt-1">
            {current.toFixed(1)}
          </div>
          <div className="text-sm text-text-secondary mt-2">
            <span className={delta >= 0 ? 'text-kept' : 'text-reverted'}>
              {delta >= 0 ? '+' : ''}
              {delta.toFixed(1)}
            </span>{' '}
            from baseline {baseline.toFixed(1)}
          </div>
        </div>
        <div className="flex gap-8 text-sm font-mono tabular-nums">
          <Stat label="iteration" value={String(iteration)} />
          <Stat label="elapsed" value={elapsed} />
          <Stat label="est. cost" value={`$${cost.toFixed(3)}`} />
          <Stat label="products kept" value={String(productsTouched)} />
        </div>
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-text-secondary">{label}</div>
      <div className="text-xl mt-1">{value}</div>
    </div>
  )
}

function lastKeptScore(entries: ExperimentLog[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.verdict === 'kept' || e.verdict === 'kept_uncertain') {
      return e.scoreAfter
    }
  }
  return null
}

function useElapsed(startedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const totalSeconds = Math.max(0, Math.floor((now - start) / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const parts: string[] = []
  if (h) parts.push(`${h}h`)
  parts.push(`${m}m`)
  parts.push(`${s.toString().padStart(2, '0')}s`)
  return parts.join(' ')
}

function usePulseOnKeep(entries: ExperimentLog[]): boolean {
  const lastLen = useRef(0)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (entries.length > lastLen.current) {
      const newest = entries[entries.length - 1]
      if (newest?.verdict === 'kept' || newest?.verdict === 'kept_uncertain') {
        setFlash(true)
        const t = setTimeout(() => setFlash(false), 600)
        lastLen.current = entries.length
        return () => clearTimeout(t)
      }
    }
    lastLen.current = entries.length
    return undefined
  }, [entries])
  return flash
}
