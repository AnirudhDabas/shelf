import {
  existsSync,
  readFileSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
} from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const HEARTBEAT_MS = 5_000
// fs.watch fires on native FS events (fast). watchFile polls as a fallback
// in case the event is missed (some editors/platforms drop events).
const WATCHFILE_INTERVAL_MS = 1_000
// ~2 KB of comment padding so the first chunk is big enough to clear any
// response buffer between the route handler and the browser's EventSource.
// Without this, early events can sit invisible for seconds on localhost dev.
const INITIAL_PADDING = ':' + ' '.repeat(2048) + '\n\n'

function logPath(): string {
  const envPath = process.env.SHELF_LOG_FILE
  if (envPath && isAbsolute(envPath)) return envPath
  // next dev runs with cwd=apps/dashboard. shelf.jsonl lives at the repo
  // root (two up), which is where the CLI loop writes it.
  const projectRoot = resolve(process.cwd(), '..', '..')
  return resolve(projectRoot, envPath ?? 'shelf.jsonl')
}

export function GET(req: NextRequest): Response {
  const file = logPath()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let cursor = 0
      let buffer = ''
      let closed = false

      const enqueue = (raw: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(raw))
        } catch {
          closed = true
        }
      }

      const send = (event: string, data: unknown): void => {
        enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const flushChunk = (chunk: string): void => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            send('experiment', JSON.parse(trimmed))
          } catch {
            // malformed line — skip
          }
        }
      }

      const readFromCursor = (): void => {
        if (closed) return
        if (!existsSync(file)) {
          send('status', { waiting: true, path: file })
          return
        }
        try {
          const size = statSync(file).size
          if (size < cursor) {
            cursor = 0
            buffer = ''
            send('reset', { path: file })
          }
          if (size > cursor) {
            const chunk = readFileSync(file, 'utf-8').slice(cursor)
            cursor = size
            flushChunk(chunk)
          }
        } catch (err) {
          send('error', { message: err instanceof Error ? err.message : String(err) })
        }
      }

      // Prime the connection: padding to defeat buffering, then hello, then
      // the full existing backlog so late joiners see history.
      enqueue(INITIAL_PADDING)
      send('hello', { path: file, startedAt: new Date().toISOString() })
      readFromCursor()

      // Primary: native FS event (fires immediately on append).
      // Watch the parent directory so we also catch the file being created
      // for the first time in a fresh workspace.
      let fsWatcher: FSWatcher | null = null
      try {
        fsWatcher = watch(dirname(file), (_event, changed) => {
          if (changed && resolve(dirname(file), changed) === file) {
            readFromCursor()
          }
        })
      } catch {
        fsWatcher = null
      }

      // Fallback: polling. Cheap, catches anything fs.watch misses.
      watchFile(file, { interval: WATCHFILE_INTERVAL_MS }, () => {
        readFromCursor()
      })

      const heartbeat = setInterval(() => {
        if (closed) return
        enqueue(`: keepalive ${Date.now()}\n\n`)
      }, HEARTBEAT_MS)

      req.signal.addEventListener('abort', () => {
        closed = true
        unwatchFile(file)
        if (fsWatcher) {
          try {
            fsWatcher.close()
          } catch {
            // already closed
          }
        }
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells Next.js / nginx / Vercel to stream bytes as they arrive
      // instead of buffering the response.
      'X-Accel-Buffering': 'no',
    },
  })
}
