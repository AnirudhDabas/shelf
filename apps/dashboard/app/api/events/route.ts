import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const HEARTBEAT_MS = 5_000
const WATCH_INTERVAL_MS = 300

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

      const send = (event: string, data: unknown): void => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          )
        } catch {
          closed = true
        }
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

      // Initial handshake — client uses this to (re)reset its experiment list.
      send('hello', { path: file, startedAt: new Date().toISOString() })
      // Emit the full existing backlog so late-joining clients see history.
      readFromCursor()

      // watchFile polls mtime/size and fires whenever the file changes.
      // Works even if the file does not exist yet — the first write triggers curr.size > 0.
      watchFile(file, { interval: WATCH_INTERVAL_MS }, () => {
        readFromCursor()
      })

      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`))
        } catch {
          closed = true
        }
      }, HEARTBEAT_MS)

      req.signal.addEventListener('abort', () => {
        closed = true
        unwatchFile(file)
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
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
