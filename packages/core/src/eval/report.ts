import type { EvalReport } from './types.js'

const METHODOLOGY_FOOTER = `Methodology inspired by "Building Production Ready Agentic Systems"
(McNamara, Lafferty, Garner — ICML 2025) and Shopify's approach to
LLM-based evaluation for Sidekick.`

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = []
  const date = report.generatedAt.slice(0, 10)
  lines.push(`# shelf eval — ${report.storeDomain} — ${date}`, '')
  lines.push(
    `_${report.totalExperiments} experiment(s) read from ${report.jsonlPath}_`,
    '',
  )

  lines.push('## Hypothesis Effectiveness', '')
  const heff = report.hypothesisEffectiveness
  if (heff.rows.length === 0) {
    lines.push('_No experiments to analyze._')
  } else {
    lines.push(
      '| type | total | kept | keep rate | avg Δ (kept) | avg Δ (reverted) | median iters → first keep | EV/attempt |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    )
    for (const r of heff.rows) {
      lines.push(
        `| ${r.type} | ${r.total} | ${r.kept} | ${(r.keepRate * 100).toFixed(0)}% | ${r.avgScoreDeltaKept.toFixed(2)} | ${r.avgScoreDeltaReverted.toFixed(2)} | ${r.medianIterationsToFirstKeep ?? '—'} | ${r.expectedValuePerAttempt.toFixed(2)} |`,
      )
    }
    lines.push('')
    if (heff.priorityOrder.length > 0) {
      lines.push(
        `**Recommended priority for a 10-iteration budget:** ${heff.priorityOrder.join(' → ')}`,
        '',
      )
    }
  }

  lines.push('## Score Stability', '')
  const stab = report.scoreStability
  if (!stab.performed) {
    lines.push(`_${stab.reason ?? 'skipped'}_`, '')
  } else if (stab.rows.length === 0) {
    lines.push(`_${stab.reason ?? 'no data'}_`, '')
  } else {
    lines.push(
      `_Per-product score across ${stab.runsPerProduct} repeat runs without changes._`,
      '',
    )
    lines.push(
      '| product | mean | std dev | CV | min | max |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
    )
    for (const r of stab.rows) {
      lines.push(
        `| ${r.productTitle} | ${r.mean.toFixed(1)} | ${r.stdDev.toFixed(2)} | ${(r.coefficientOfVariation * 100).toFixed(1)}% | ${r.min.toFixed(1)} | ${r.max.toFixed(1)} |`,
      )
    }
    lines.push(
      '',
      `**Mean CV across products:** ${(stab.meanCoefficientOfVariation * 100).toFixed(1)}%`,
      '',
      stab.verdictMessage,
      '',
    )
  }

  lines.push('## Plateau Detection', '')
  const plateau = report.plateau
  if (plateau.series.length === 0) {
    lines.push(`_${plateau.verdict}_`, '')
  } else {
    lines.push(plateau.verdict, '')
    lines.push(
      `Trajectory: baseline ${plateau.baselineScore.toFixed(1)} → final ${plateau.finalScore.toFixed(1)} over ${plateau.totalIterations} iteration(s).`,
      '',
    )
    lines.push(
      `Cost: $${plateau.cumulativeCostUsd.toFixed(4)}` +
        (plateau.costPerScorePoint !== null
          ? ` (~$${plateau.costPerScorePoint.toFixed(4)} per score point gained)`
          : ' (no positive score gain)'),
      '',
    )
    lines.push('```', renderAsciiChart(plateau.series), '```', '')
  }

  lines.push('## Provider Disagreement', '')
  const pd = report.providerDisagreement
  if (!pd.available) {
    lines.push(`_${pd.reason ?? 'unavailable'}_`, '')
  } else {
    lines.push(
      '| provider | keep rate | final score |',
      '| --- | ---: | ---: |',
    )
    for (const name of pd.providers) {
      const series = pd.perProviderScoreTrajectory[name] ?? []
      const last = series[series.length - 1]
      const finalScore = last ? last.score : 0
      lines.push(
        `| ${name} | ${(pd.perProviderKeepRate[name] * 100).toFixed(0)}% | ${finalScore.toFixed(1)} |`,
      )
    }
    lines.push(
      '',
      `Disagreement rate: ${(pd.disagreementRate * 100).toFixed(1)}%`,
      '',
      pd.verdict,
      '',
    )
  }

  lines.push('## Reward Hacking Audit', '')
  const rh = report.rewardHacking
  if (!rh.available) {
    lines.push(`_${rh.reason ?? 'unavailable'}_`, '')
  } else {
    lines.push(`**Risk: ${rh.risk.toUpperCase()}** — ${rh.verdict}`, '')
    lines.push(
      `- title length slope: ${rh.titleLengthSlope.toFixed(3)} chars/iter (n=${rh.titleLengthSeries.length})`,
      `- description grade slope: ${rh.descriptionGradeSlope.toFixed(3)} grade/iter (n=${rh.descriptionGradeSeries.length})`,
      `- max keyword count slope: ${rh.keywordDensitySlope.toFixed(3)} /iter (n=${rh.keywordDensitySeries.length})`,
      `- coverage: ${rh.productCoverage.uniqueProducts} unique product(s) across ${rh.productCoverage.keptExperiments} kept experiment(s) (top product share ${(rh.productCoverage.topProductShare * 100).toFixed(0)}%)`,
      '',
    )
    if (rh.signals.length > 0) {
      lines.push('Signals:')
      for (const s of rh.signals) lines.push(`- ${s}`)
      lines.push('')
    }
  }

  lines.push('## Summary', '', report.summary, '')
  lines.push('---', METHODOLOGY_FOOTER, '')
  return lines.join('\n')
}

// 12-row sparkline rendered with block characters. The optimization curve
// is the focal point of any eval — a tiny ASCII chart in shelf-eval.md
// keeps the file readable without depending on the dashboard.
function renderAsciiChart(series: { iteration: number; score: number }[]): string {
  if (series.length === 0) return ''
  const height = 12
  const width = Math.min(60, series.length)
  const step = Math.max(1, Math.floor(series.length / width))
  const sampled: { iteration: number; score: number }[] = []
  for (let i = 0; i < series.length; i += step) sampled.push(series[i])
  const last = series[series.length - 1]
  if (sampled[sampled.length - 1] !== last) sampled.push(last)

  const scores = sampled.map((p) => p.score)
  const maxScore = Math.max(...scores, 1)
  const minScore = Math.min(...scores, 0)
  const span = Math.max(1, maxScore - minScore)

  const rows: string[] = []
  for (let row = height - 1; row >= 0; row--) {
    const threshold = minScore + (span * row) / (height - 1)
    let line = `${threshold.toFixed(0).padStart(3)} | `
    for (const s of scores) {
      line += s >= threshold ? '█' : ' '
    }
    rows.push(line)
  }
  rows.push('    ' + '-'.repeat(scores.length + 1))
  rows.push(
    '     ' +
      `iter ${sampled[0].iteration}`.padEnd(Math.max(0, scores.length - 6)) +
      `iter ${last.iteration}`,
  )
  return rows.join('\n')
}

export function buildSummary(report: Omit<EvalReport, 'summary'>): string {
  const heff = report.hypothesisEffectiveness
  const plateau = report.plateau
  const rh = report.rewardHacking

  const parts: string[] = []
  if (heff.rows.length > 0) {
    const top = heff.rows[0]
    parts.push(
      `Of ${heff.totalExperiments} experiment(s), ${heff.totalKept} were kept (${((heff.totalKept / Math.max(1, heff.totalExperiments)) * 100).toFixed(0)}%); ${top.type} led with a ${(top.keepRate * 100).toFixed(0)}% keep rate.`,
    )
  }
  if (plateau.series.length > 0) {
    parts.push(
      plateau.plateauIteration !== null
        ? `Score plateaued by iteration ${plateau.plateauIteration}; further iterations are unlikely to pay back.`
        : `Score climbed ${plateau.baselineScore.toFixed(1)} → ${plateau.finalScore.toFixed(1)} with no plateau yet — the loop has runway.`,
    )
  }
  if (rh.available) {
    parts.push(`Reward-hacking risk: ${rh.risk}.`)
  }

  if (parts.length === 0) return 'Insufficient data to summarize.'
  return parts.join(' ')
}
