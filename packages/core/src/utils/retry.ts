export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  shouldRetry?: (err: unknown) => boolean
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3
  const baseDelay = options.baseDelayMs ?? 1000
  const maxDelay = options.maxDelayMs ?? 8000
  const shouldRetry = options.shouldRetry ?? (() => true)

  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i === attempts - 1 || !shouldRetry(err)) break
      const delay = Math.min(baseDelay * 2 ** i, maxDelay)
      await sleep(delay)
    }
  }
  throw lastErr
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
