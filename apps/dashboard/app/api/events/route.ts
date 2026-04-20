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
// 500ms polling fallback — fires even if fs.watch silently drops events.
const WATCHFILE_INTERVAL_MS = 500
// ~2 KB of comment padding so the first chunk is big enough to clear any
// response buffer between the route handler and the browser's EventSource.
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
  const connId = Math.random().toString(36).slice(2, 8)

  const stream = new ReadableStream({
    start(controller) {
      let cursor = 0
      let buffer = ''
      let closed = false
      let fileWatcher: FSWatcher | null = null
      let dirWatcher: FSWatcher | null = null

      const enqueue = (raw: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(raw))
        } catch (err) {
          console.log(`[sse ${connId}] enqueue failed, closing: ${(err as Error).message}`)
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
        let emitted = 0
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            send('experiment', JSON.parse(trimmed))
            emitted++
          } catch {
            // malformed line — skip
          }
        }
        if (emitted > 0) {
          console.log(`[sse ${connId}] emitted ${emitted} experiment event(s)`)
        }
      }

      const readFromCursor = (source: string): void => {
        if (closed) return
        if (!existsSync(file)) {
          send('status', { waiting: true, path: file })
          return
        }
        try {
          const size = statSync(file).size
          if (size < cursor) {
            console.log(`[sse ${connId}] ${source}: file truncated (${cursor} -> ${size}), resetting`)
            cursor = 0
            buffer = ''
            send('reset', { path: file })
          }
          if (size > cursor) {
            const newBytes = size - cursor
            console.log(`[sse ${connId}] ${source}: reading ${newBytes} new bytes (cursor ${cursor} -> ${size})`)
            const chunk = readFileSync(file, 'utf-8').slice(cursor)
            cursor = size
            flushChunk(chunk)
          }
        } catch (err) {
          console.log(`[sse ${connId}] readFromCursor error: ${(err as Error).message}`)
          send('error', { message: err instanceof Error ? err.message : String(err) })
        }
      }

      // Primary watcher: fs.watch on the file itself. Fires on every
      // modification, no filename-filter guesswork. Detach/reattach via
      // the dir watcher if the file is replaced (rename-write pattern).
      const attachFileWatcher = (): void => {
        if (fileWatcher || closed) return
        if (!existsSync(file)) return
        try {
          fileWatcher = watch(file, { persistent: true }, (event) => {
            console.log(`[sse ${connId}] fs.watch(file) fired: event=${event}`)
            if (event === 'rename') {
              // Some editors write via rename(tmp, target); the old fd is
              // gone. Reattach on the next tick after confirming the file
              // is back on disk.
              try {
                fileWatcher?.close()
              } catch {
                // ignore
              }
              fileWatcher = null
              setTimeout(() => {
                attachFileWatcher()
                readFromCursor('fs.watch(file)/rename')
              }, 50)
              return
            }
            readFromCursor('fs.watch(file)')
          })
          fileWatcher.on('error', (err) => {
            console.log(`[sse ${connId}] fs.watch(file) error: ${err.message}`)
          })
          console.log(`[sse ${connId}] attached fs.watch to ${file}`)
        } catch (err) {
          console.log(`[sse ${connId}] fs.watch(file) setup failed: ${(err as Error).message}`)
          fileWatcher = null
        }
      }

      // Dir watcher: catches the file being created for the first time.
      // On any dir event we (re)attach the file watcher and re-read.
      try {
        dirWatcher = watch(dirname(file), { persistent: true }, (event, changed) => {
          console.log(`[sse ${connId}] fs.watch(dir) fired: event=${event}, changed=${changed ?? '<null>'}`)
          if (!fileWatcher) attachFileWatcher()
          readFromCursor('fs.watch(dir)')
        })
        dirWatcher.on('error', (err) => {
          console.log(`[sse ${connId}] fs.watch(dir) error: ${err.message}`)
        })
      } catch (err) {
        console.log(`[sse ${connId}] fs.watch(dir) setup failed: ${(err as Error).message}`)
        dirWatcher = null
      }

      // Polling fallback: keeps working even if both fs.watch handles
      // silently stop firing (has happened on some Windows setups when
      // the directory's security descriptor changes mid-stream).
      watchFile(file, { interval: WATCHFILE_INTERVAL_MS, persistent: true }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
          console.log(`[sse ${connId}] watchFile fired: size ${prev.size} -> ${curr.size}`)
          readFromCursor('watchFile')
        }
      })

      // Prime the connection: padding → hello → full backlog.
      enqueue(INITIAL_PADDING)
      send('hello', { path: file, startedAt: new Date().toISOString() })
      readFromCursor('initial')
      attachFileWatcher()

      const heartbeat = setInterval(() => {
        if (closed) return
        enqueue(`: keepalive ${Date.now()}\n\n`)
      }, HEARTBEAT_MS)

      req.signal.addEventListener('abort', () => {
        console.log(`[sse ${connId}] client aborted, tearing down watchers`)
        closed = true
        unwatchFile(file)
        if (fileWatcher) {
          try {
            fileWatcher.close()
          } catch {
            // already closed
          }
          fileWatcher = null
        }
        if (dirWatcher) {
          try {
            dirWatcher.close()
          } catch {
            // already closed
          }
          dirWatcher = null
        }
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })

      console.log(`[sse ${connId}] connection established, watching ${file}`)
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
