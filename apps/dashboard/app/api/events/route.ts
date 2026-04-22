import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const HEARTBEAT_MS = 5_000
// fs.watch / watchFile both proved unreliable here (events either silently
// dropped mid-stream or only fired on the next unrelated fs op). Straight
// polling at 500ms is simpler and actually detects appends live.
const POLL_INTERVAL_MS = 500
// ~2 KB of comment padding so the first chunk is big enough to clear any
// response buffer between the route handler and the browser's EventSource.
const INITIAL_PADDING = ':' + ' '.repeat(2048) + '\n\n'

function projectRoot(): string {
  // next dev runs with cwd=apps/dashboard. Everything the CLI writes
  // (shelf.jsonl, .shelf-cache/) lives two dirs up at the repo root.
  return resolve(process.cwd(), '..', '..')
}

function logPath(): string {
  const envPath = process.env.SHELF_LOG_FILE
  if (envPath && isAbsolute(envPath)) return envPath
  return resolve(projectRoot(), envPath ?? 'shelf.jsonl')
}

function readElapsedMultiplier(): number {
  const envVal = Number.parseFloat(process.env.SHELF_ELAPSED_MULTIPLIER ?? '')
  if (Number.isFinite(envVal) && envVal > 0) return envVal
  try {
    const raw = readFileSync(resolve(projectRoot(), '.shelf-cache', 'elapsed-multiplier'), 'utf-8').trim()
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n) && n > 0) return n
  } catch {
    // sidecar absent — no fake elapsed
  }
  return 1
}

export function GET(req: NextRequest): Response {
  const file = logPath()
  const fileLabel = basename(file)
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let lastSize = 0
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

      const readNewBytes = (): void => {
        if (closed) return
        if (!existsSync(file)) {
          send('status', { waiting: true, file: fileLabel })
          return
        }
        try {
          const size = statSync(file).size
          if (size < lastSize) {
            lastSize = 0
            buffer = ''
            send('reset', { file: fileLabel })
          }
          if (size > lastSize) {
            const newBytes = size - lastSize
            const fd = openSync(file, 'r')
            const buf = Buffer.alloc(newBytes)
            readSync(fd, buf, 0, newBytes, lastSize)
            closeSync(fd)
            lastSize = size
            flushChunk(buf.toString('utf-8'))
          }
        } catch (err) {
          send('error', { message: err instanceof Error ? err.message : String(err) })
        }
      }

      // Prime the connection: padding → hello → full backlog.
      enqueue(INITIAL_PADDING)
      send('hello', {
        file: fileLabel,
        startedAt: new Date().toISOString(),
        elapsedMultiplier: readElapsedMultiplier(),
      })
      readNewBytes()

      // fs.watch / watchFile both failed to fire on appends mid-stream in
      // this setup. Plain setInterval polling is reliable.
      const poll = setInterval(() => {
        if (closed) return
        readNewBytes()
      }, POLL_INTERVAL_MS)

      const heartbeat = setInterval(() => {
        if (closed) return
        enqueue(`: keepalive ${Date.now()}\n\n`)
      }, HEARTBEAT_MS)

      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(poll)
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
      'X-Accel-Buffering': 'no',
    },
  })
}
