import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const POLL_INTERVAL_MS = 500

function logPath(): string {
  return resolve(process.cwd(), process.env.SHELF_LOG_FILE ?? 'shelf.jsonl')
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

      const flushNewLines = (chunk: string): void => {
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

      const tick = (): void => {
        if (closed) return
        try {
          if (!existsSync(file)) {
            send('status', { waiting: true, path: file })
            return
          }
          const size = statSync(file).size
          if (size < cursor) {
            cursor = 0
            buffer = ''
            send('reset', { path: file })
          }
          if (size > cursor) {
            const fd = readFileSync(file, 'utf-8')
            const chunk = fd.slice(cursor)
            cursor = size
            flushNewLines(chunk)
          }
        } catch (err) {
          send('error', { message: err instanceof Error ? err.message : String(err) })
        }
      }

      send('hello', { path: file, startedAt: new Date().toISOString() })
      tick()
      const interval = setInterval(tick, POLL_INTERVAL_MS)
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`))
        } catch {
          closed = true
        }
      }, 15_000)

      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(interval)
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
