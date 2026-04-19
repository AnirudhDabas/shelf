'use client'
import { useEffect, useState } from 'react'
import type { ExperimentLog } from '@shelf/core'

export interface EventsState {
  experiments: ExperimentLog[]
  waitingForFile: boolean
  connected: boolean
  path: string | null
}

// SSE subscriber — tails the /api/events stream and accumulates experiments
// in order. We intentionally keep the full history in memory; a live
// optimization run produces well under ten thousand entries, so windowing
// would add complexity without paying off.
export function useEvents(): EventsState {
  const [state, setState] = useState<EventsState>({
    experiments: [],
    waitingForFile: true,
    connected: false,
    path: null,
  })

  useEffect(() => {
    const source = new EventSource('/api/events')

    source.addEventListener('hello', (ev) => {
      try {
        const payload = JSON.parse(ev.data) as { path?: string }
        setState((prev) => ({ ...prev, connected: true, path: payload.path ?? null }))
      } catch {
        setState((prev) => ({ ...prev, connected: true }))
      }
    })

    source.addEventListener('status', (ev) => {
      try {
        const payload = JSON.parse(ev.data) as { waiting?: boolean }
        setState((prev) => ({ ...prev, waitingForFile: payload.waiting === true }))
      } catch {
        // noop
      }
    })

    source.addEventListener('reset', () => {
      setState((prev) => ({ ...prev, experiments: [] }))
    })

    source.addEventListener('experiment', (ev) => {
      try {
        const entry = JSON.parse(ev.data) as ExperimentLog
        setState((prev) => ({
          ...prev,
          waitingForFile: false,
          experiments: [...prev.experiments, entry],
        }))
      } catch {
        // noop
      }
    })

    source.onerror = () => {
      setState((prev) => ({ ...prev, connected: false }))
    }

    return () => {
      source.close()
    }
  }, [])

  return state
}
