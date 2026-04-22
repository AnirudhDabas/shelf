/**
 * Convert a shelf.jsonl log into a readable markdown trace, iteration by iteration.
 *
 * Usage:
 *   pnpm tsx scripts/export-trace.ts                            # reads ./shelf.jsonl → ./shelf-trace.md
 *   pnpm tsx scripts/export-trace.ts path/to/shelf.jsonl        # custom input
 *   pnpm tsx scripts/export-trace.ts path/in.jsonl path/out.md  # custom in/out
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JsonlLogger, type ExperimentLog, type Verdict } from '@shelf/core'

const VERDICT_LABEL: Record<Verdict, string> = {
  kept: 'kept',
  kept_uncertain: 'kept (uncertain)',
  reverted: 'reverted',
  checks_failed: 'checks failed',
  generator_failed: 'generator failed',
  apply_failed: 'apply failed',
  measure_failed: 'measure failed',
}

function signed(n: number): string {
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2)
}

function renderEntry(e: ExperimentLog): string {
  const lines: string[] = []
  lines.push(`## Iteration ${e.iteration} — ${VERDICT_LABEL[e.verdict]}`)
  lines.push('')
  lines.push(`- **Product**: ${e.hypothesis.productTitle} (\`${e.hypothesis.productId}\`)`)
  lines.push(`- **Type**: ${e.hypothesis.type} on \`${e.hypothesis.field}\``)
  lines.push(`- **Risk**: ${e.hypothesis.riskLevel}`)
  lines.push(`- **Score**: ${e.scoreBefore.toFixed(1)} → ${e.scoreAfter.toFixed(1)} (Δ ${signed(e.scoreDelta)})`)
  lines.push(`- **Confidence**: ${e.confidenceLevel} (${e.confidence.toFixed(2)})`)
  lines.push(`- **Duration**: ${e.durationMs}ms · cost $${e.costEstimateUsd.toFixed(4)}`)
  lines.push(`- **Timestamp**: ${e.timestamp}`)
  lines.push('')
  lines.push(`**Hypothesis**: ${e.hypothesis.description}`)
  lines.push('')
  lines.push(`**Predicted effect**: ${e.hypothesis.predictedEffect}`)
  lines.push('')
  lines.push('### Before')
  lines.push('```')
  lines.push(e.hypothesis.before || '(empty)')
  lines.push('```')
  lines.push('')
  lines.push('### After')
  lines.push('```')
  lines.push(e.hypothesis.after || '(empty)')
  lines.push('```')
  lines.push('')
  if (e.failures && e.failures.length > 0) {
    lines.push(`**Failures**: ${e.failures.join(' · ')}`)
    lines.push('')
  }
  if (e.error) {
    lines.push(`**Error**: ${e.error}`)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

function renderHeader(entries: ExperimentLog[]): string {
  const kept = entries.filter((e) => e.verdict === 'kept').length
  const keptUncertain = entries.filter((e) => e.verdict === 'kept_uncertain').length
  const reverted = entries.filter((e) => e.verdict === 'reverted').length
  const failed = entries.filter(
    (e) =>
      e.verdict === 'checks_failed' ||
      e.verdict === 'generator_failed' ||
      e.verdict === 'apply_failed' ||
      e.verdict === 'measure_failed',
  ).length
  const cost = entries.reduce((s, e) => s + (e.costEstimateUsd ?? 0), 0)
  const baseline = entries[0]?.scoreBefore ?? 0
  const lastKept = [...entries].reverse().find(
    (e) => e.verdict === 'kept' || e.verdict === 'kept_uncertain',
  )
  const final = lastKept?.scoreAfter ?? baseline
  const first = entries[0]?.timestamp ?? '—'
  const last = entries.at(-1)?.timestamp ?? '—'

  return [
    '# shelf trace',
    '',
    `- **Iterations**: ${entries.length}`,
    `- **Kept**: ${kept} · Kept-uncertain: ${keptUncertain} · Reverted: ${reverted} · Failed: ${failed}`,
    `- **Score**: ${baseline.toFixed(1)} → ${final.toFixed(1)} (Δ ${signed(final - baseline)})`,
    `- **Total cost**: $${cost.toFixed(4)}`,
    `- **Window**: ${first} → ${last}`,
    '',
    '---',
    '',
  ].join('\n')
}

function main() {
  const [, , inputArg, outputArg] = process.argv
  const inputPath = resolve(process.cwd(), inputArg ?? 'shelf.jsonl')
  const outputPath = resolve(process.cwd(), outputArg ?? 'shelf-trace.md')

  const logger = new JsonlLogger(inputPath)
  const entries = logger.readAll()

  if (entries.length === 0) {
    console.error(`no entries found at ${inputPath}`)
    process.exit(1)
  }

  const body = [renderHeader(entries), ...entries.map(renderEntry)].join('')
  writeFileSync(outputPath, body, 'utf-8')

  console.log(`wrote ${entries.length} iterations to ${outputPath}`)
}

main()
