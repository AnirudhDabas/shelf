'use client'
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ExperimentLog } from '@shelf/core'

interface ScoreChartProps {
  experiments: ExperimentLog[]
}

// Recharts colors copied from tailwind.config so the SVG inherits the
// dashboard palette even though Recharts renders outside Tailwind's scope.
const COLOR_KEPT = '#22c55e'
const COLOR_REVERTED = '#ef4444'
const COLOR_UNCERTAIN = '#eab308'
const COLOR_LINE = '#3b82f6'
const COLOR_GRID = '#1e1e1e'
const COLOR_AXIS = '#737373'

interface ChartPoint {
  iteration: number
  score: number
  verdict: ExperimentLog['verdict']
  description: string
  productTitle: string
  scoreDelta: number
}

export function ScoreChart({ experiments }: ScoreChartProps) {
  const data: ChartPoint[] = experiments.map((e) => ({
    iteration: e.iteration,
    score: e.scoreAfter,
    verdict: e.verdict,
    description: e.hypothesis.description,
    productTitle: e.hypothesis.productTitle,
    scoreDelta: e.scoreDelta,
  }))

  const keptData = data.filter((d) => d.verdict === 'kept' || d.verdict === 'kept_uncertain')
  const revertedData = data.filter((d) => d.verdict === 'reverted')
  const uncertainData = data.filter((d) => d.verdict === 'kept_uncertain')

  // With three scatters + one line, a category X axis lists each series'
  // iteration values in sequence and repeats (e.g. "1 2 5 … 1 2 5 …").
  // Force a numeric axis with explicit integer ticks so labels stay
  // monotonic and de-duped.
  const maxIteration = Math.max(25, ...data.map((d) => d.iteration))
  const ticks = Array.from({ length: maxIteration }, (_, i) => i + 1)

  return (
    <section className="border-b border-border bg-surface px-6 py-5">
      <header className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wider text-text-secondary">
          score progression
        </h2>
        <div className="text-xs font-mono text-text-secondary">
          {keptData.length} kept · {revertedData.length} reverted
        </div>
      </header>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke={COLOR_GRID} vertical={false} />
            <XAxis
              dataKey="iteration"
              type="number"
              domain={[1, maxIteration]}
              ticks={ticks}
              allowDecimals={false}
              allowDuplicatedCategory={false}
              interval={0}
              stroke={COLOR_AXIS}
              tick={{ fill: COLOR_AXIS, fontSize: 11, fontFamily: 'var(--font-jetbrains)' }}
              tickLine={false}
              label={{
                value: 'iteration',
                position: 'insideBottom',
                offset: -5,
                fill: COLOR_AXIS,
                fontSize: 10,
              }}
            />
            <YAxis
              domain={[0, 100]}
              stroke={COLOR_AXIS}
              tick={{ fill: COLOR_AXIS, fontSize: 11, fontFamily: 'var(--font-jetbrains)' }}
              tickLine={false}
              width={32}
            />
            <Tooltip
              contentStyle={{
                background: '#0a0a0a',
                border: '1px solid #1e1e1e',
                fontSize: 12,
              }}
              labelStyle={{ color: COLOR_AXIS }}
              itemStyle={{ color: '#e5e5e5' }}
              cursor={{ stroke: COLOR_AXIS, strokeDasharray: '3 3' }}
              formatter={(_v, _n, entry) => {
                const p = entry.payload as ChartPoint | undefined
                if (!p) return ['', '']
                return [`${p.score.toFixed(1)} (Δ ${p.scoreDelta.toFixed(2)})`, p.productTitle]
              }}
            />
            <Line
              data={keptData}
              dataKey="score"
              type="monotone"
              stroke={COLOR_LINE}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            <Scatter data={keptData} fill={COLOR_KEPT} shape="circle" />
            <Scatter data={uncertainData} fill={COLOR_UNCERTAIN} shape="circle" />
            <Scatter data={revertedData} fill={COLOR_REVERTED} shape="circle" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
