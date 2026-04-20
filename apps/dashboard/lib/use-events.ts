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

    // hello fires on every (re)connection. The server replays the full
    // backlog afterwards, so we reset local state to avoid duplicates.
    source.addEventListener('hello', (ev) => {
      let path: string | null = null
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as { path?: string }
        path = payload.path ?? null
      } catch {
        // noop
      }
      setState((prev) => ({
        ...prev,
        connected: true,
        path: path ?? prev.path,
        experiments: [],
      }))
    })

    source.addEventListener('status', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as { waiting?: boolean }
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
        const entry = JSON.parse((ev as MessageEvent).data) as ExperimentLog
        setState((prev) => {
          // De-dupe by id in case of reconnect races — server replays the
          // whole file on each new connection.
          if (prev.experiments.some((e) => e.id === entry.id)) return prev
          return {
            ...prev,
            waitingForFile: false,
            experiments: [...prev.experiments, entry],
          }
        })
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
