'use client'
import { useState } from 'react'
import type { ExperimentLog } from '@shelf/core'

interface ExperimentTableProps {
  experiments: ExperimentLog[]
}

const VERDICT_COLORS: Record<ExperimentLog['verdict'], string> = {
  kept: 'bg-kept/15 text-kept border-kept/30',
  kept_uncertain: 'bg-uncertain/15 text-uncertain border-uncertain/30',
  reverted: 'bg-reverted/15 text-reverted border-reverted/30',
  checks_failed: 'bg-text-secondary/15 text-text-secondary border-text-secondary/30',
  apply_failed: 'bg-text-secondary/15 text-text-secondary border-text-secondary/30',
  measure_failed: 'bg-text-secondary/15 text-text-secondary border-text-secondary/30',
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'bg-kept/15 text-kept border-kept/30',
  medium: 'bg-running/15 text-running border-running/30',
  low: 'bg-uncertain/15 text-uncertain border-uncertain/30',
  noise: 'bg-text-secondary/15 text-text-secondary border-text-secondary/30',
}

export function ExperimentTable({ experiments }: ExperimentTableProps) {
  const recent = [...experiments].reverse().slice(0, 20)
  return (
    <section className="bg-surface">
      <header className="border-b border-border px-6 py-3 flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wider text-text-secondary">
          recent experiments
        </h2>
        <div className="text-xs font-mono text-text-secondary">
          showing {recent.length} of {experiments.length}
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-secondary text-xs uppercase tracking-wider">
              <Th className="w-12">#</Th>
              <Th>product</Th>
              <Th>type</Th>
              <Th>new value</Th>
              <Th className="text-right">score</Th>
              <Th className="text-right">Δ</Th>
              <Th>verdict</Th>
              <Th>confidence</Th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-8 text-center text-text-secondary">
                  waiting for experiments…
                </td>
              </tr>
            ) : (
              recent.map((exp, i) => (
                <ExperimentRow key={exp.id} exp={exp} alt={i % 2 === 1} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 text-left font-medium ${className}`}>{children}</th>
}

function ExperimentRow({ exp, alt }: { exp: ExperimentLog; alt: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const signed = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2))
  return (
    <>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className={`cursor-pointer border-b border-border hover:bg-bg ${alt ? 'bg-bg/40' : ''}`}
      >
        <td className="px-4 py-3 font-mono tabular-nums text-text-secondary">{exp.iteration}</td>
        <td className="px-4 py-3 max-w-[16rem] truncate">{exp.hypothesis.productTitle}</td>
        <td className="px-4 py-3 font-mono text-xs text-text-secondary">{exp.hypothesis.type}</td>
        <td
          className="px-4 py-3 max-w-[20rem] truncate text-text-primary font-mono text-xs"
          title={exp.hypothesis.after}
        >
          {exp.hypothesis.after || '—'}
        </td>
        <td className="px-4 py-3 text-right font-mono tabular-nums">
          {exp.scoreBefore.toFixed(1)} → {exp.scoreAfter.toFixed(1)}
        </td>
        <td
          className={`px-4 py-3 text-right font-mono tabular-nums ${
            exp.scoreDelta > 0
              ? 'text-kept'
              : exp.scoreDelta < 0
                ? 'text-reverted'
                : 'text-text-secondary'
          }`}
        >
          {signed(exp.scoreDelta)}
        </td>
        <td className="px-4 py-3">
          <Badge className={VERDICT_COLORS[exp.verdict]}>{exp.verdict.replace('_', ' ')}</Badge>
        </td>
        <td className="px-4 py-3">
          <Badge className={CONFIDENCE_COLORS[exp.confidenceLevel] ?? ''}>
            {exp.confidenceLevel}
          </Badge>
        </td>
      </tr>
      {expanded ? <DetailRow exp={exp} /> : null}
    </>
  )
}

function DetailRow({ exp }: { exp: ExperimentLog }) {
  return (
    <tr className="border-b border-border bg-bg/60">
      <td colSpan={8} className="px-8 py-4">
        <div className="grid grid-cols-2 gap-6 font-mono text-xs">
          <DiffBlock label="before" value={exp.hypothesis.before} />
          <DiffBlock label="after" value={exp.hypothesis.after} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 text-xs font-mono text-text-secondary">
          <Pair label="id" value={exp.id} />
          <Pair label="timestamp" value={exp.timestamp} />
          <Pair label="field" value={exp.hypothesis.field} />
          <Pair label="risk" value={exp.hypothesis.riskLevel} />
          <Pair label="predicted effect" value={exp.hypothesis.predictedEffect} />
          <Pair label="prompt version" value={exp.hypothesis.promptVersion} />
          <Pair label="duration" value={`${exp.durationMs}ms`} />
          <Pair label="cost" value={`$${exp.costEstimateUsd.toFixed(4)}`} />
          {exp.error ? <Pair label="error" value={exp.error} /> : null}
          {exp.failures?.length ? (
            <Pair label="failures" value={exp.failures.join(' · ')} />
          ) : null}
        </dl>
      </td>
    </tr>
  )
}

function DiffBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-text-secondary uppercase text-[10px] tracking-wider">{label}</div>
      <pre className="whitespace-pre-wrap break-words rounded border border-border bg-bg p-3 max-h-48 overflow-y-auto">
        {value || '—'}
      </pre>
    </div>
  )
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="min-w-[7rem] text-text-secondary">{label}</dt>
      <dd className="text-text-primary break-all">{value}</dd>
    </div>
  )
}

function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider font-mono ${className}`}
    >
      {children}
    </span>
  )
}
