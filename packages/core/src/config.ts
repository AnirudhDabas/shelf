import { config as loadEnv } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface ShelfConfig {
  store: {
    domain: string
    // Either a long-lived shpat_ token...
    adminAccessToken?: string
    // ...or OAuth client credentials. When both are set, client credentials win.
    clientId?: string
    clientSecret?: string
  }
  providers: {
    perplexity?: { apiKey: string }
    openai?: { apiKey: string }
    anthropic?: { apiKey: string }
  }
  loop: {
    maxIterations: number
    budgetLimitUsd: number
    queriesPerMeasurement: number
  }
  paths: {
    logFile: string
    sessionFile: string
  }
  dryRun: boolean
  noShopify: boolean
}

export interface LoadConfigOverrides {
  dryRun?: boolean
  noShopify?: boolean
  maxIterations?: number
  budgetLimitUsd?: number
  queriesPerMeasurement?: number
  logFile?: string
  sessionFile?: string
  envPath?: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_BUDGET_USD = 5
const DEFAULT_REPETITIONS = 3
const DEFAULT_LOG_FILE = 'shelf.jsonl'
const DEFAULT_SESSION_FILE = 'shelf.md'

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

export function loadConfig(overrides: LoadConfigOverrides = {}): ShelfConfig {
  const envPath = overrides.envPath ?? resolve(process.cwd(), '.env')
  if (existsSync(envPath)) {
    loadEnv({ path: envPath })
  } else {
    loadEnv()
  }

  const dryRun = overrides.dryRun ?? false
  const noShopify = overrides.noShopify ?? false

  const domain = process.env.SHOPIFY_STORE_DOMAIN ?? (noShopify ? 'dry-run.myshopify.com' : undefined)
  const adminAccessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  const clientId = process.env.SHOPIFY_CLIENT_ID
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET

  if (!domain) {
    throw new ConfigError('SHOPIFY_STORE_DOMAIN is required. Run `shelf init` to set it up.')
  }
  if (!noShopify && !(clientId && clientSecret) && !adminAccessToken) {
    throw new ConfigError(
      'Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (recommended — auto-refreshing OAuth) or SHOPIFY_ADMIN_ACCESS_TOKEN.',
    )
  }

  const providers: ShelfConfig['providers'] = {}
  if (process.env.PERPLEXITY_API_KEY) {
    providers.perplexity = { apiKey: process.env.PERPLEXITY_API_KEY }
  }
  if (process.env.OPENAI_API_KEY) {
    providers.openai = { apiKey: process.env.OPENAI_API_KEY }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY }
  }

  if (!dryRun && !providers.perplexity && !providers.openai && !providers.anthropic) {
    throw new ConfigError(
      'At least one scoring provider API key is required (PERPLEXITY_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY).',
    )
  }

  return {
    store: {
      domain,
      adminAccessToken,
      clientId,
      clientSecret,
    },
    providers,
    loop: {
      maxIterations:
        overrides.maxIterations ??
        parseNumber(process.env.SHELF_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS),
      budgetLimitUsd:
        overrides.budgetLimitUsd ??
        parseNumber(process.env.SHELF_BUDGET_LIMIT_USD, DEFAULT_BUDGET_USD),
      queriesPerMeasurement:
        overrides.queriesPerMeasurement ??
        parseNumber(process.env.SHELF_QUERIES_PER_MEASUREMENT, DEFAULT_REPETITIONS),
    },
    paths: {
      logFile: overrides.logFile ?? process.env.SHELF_LOG_FILE ?? DEFAULT_LOG_FILE,
      sessionFile:
        overrides.sessionFile ?? process.env.SHELF_SESSION_FILE ?? DEFAULT_SESSION_FILE,
    },
    dryRun,
    noShopify,
  }
}
