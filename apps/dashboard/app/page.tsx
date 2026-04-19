'use client'
import { useEvents } from '../lib/use-events'
import { ExperimentTable } from '../components/experiment-table'
import { ScoreChart } from '../components/score-chart'
import { StatusBar } from '../components/status-bar'

export default function Page() {
  const { experiments, waitingForFile, connected, path } = useEvents()
  const startedAt = experiments[0]?.timestamp ?? null

  return (
    <main className="min-h-screen">
      <header className="border-b border-border px-6 py-4 flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="font-mono text-lg">shelf</h1>
          <span className="text-xs text-text-secondary uppercase tracking-wider">
            autoresearch dashboard
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-text-secondary">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected ? 'bg-kept' : 'bg-reverted'
            }`}
          />
          {connected ? 'connected' : 'disconnected'}
          {path ? <span className="ml-2">· {path}</span> : null}
        </div>
      </header>
      <StatusBar experiments={experiments} startedAt={startedAt} />
      <ScoreChart experiments={experiments} />
      <ExperimentTable experiments={experiments} />
      {waitingForFile && experiments.length === 0 ? (
        <div className="px-6 py-6 text-sm text-text-secondary">
          no experiments yet. run{' '}
          <code className="font-mono text-text-primary">npx shelf run</code> in the same
          directory to populate the log.
        </div>
      ) : null}
    </main>
  )
}
