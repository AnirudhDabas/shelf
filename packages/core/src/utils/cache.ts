import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface CacheEntry<T> {
  key: string
  value: T
  createdAt: string
}

export class FileCache {
  private dir: string

  constructor(dir = '.shelf-cache') {
    this.dir = resolve(process.cwd(), dir)
    mkdirSync(this.dir, { recursive: true })
  }

  private pathFor(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex')
    return resolve(this.dir, `${hash}.json`)
  }

  get<T>(key: string): T | null {
    const path = this.pathFor(key)
    if (!existsSync(path)) return null
    try {
      const raw = readFileSync(path, 'utf-8')
      const entry = JSON.parse(raw) as CacheEntry<T>
      return entry.value
    } catch {
      return null
    }
  }

  set<T>(key: string, value: T): void {
    const path = this.pathFor(key)
    mkdirSync(dirname(path), { recursive: true })
    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(path, JSON.stringify(entry), 'utf-8')
  }

  has(key: string): boolean {
    return existsSync(this.pathFor(key))
  }
}

export function cacheKey(...parts: Array<string | number | undefined>): string {
  return parts
    .filter((p) => p !== undefined)
    .map((p) => String(p))
    .join('|')
}
