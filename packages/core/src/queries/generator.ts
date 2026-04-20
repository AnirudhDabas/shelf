import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { nanoid } from 'nanoid'
import { retry } from '../utils/retry.js'
import { estimateCost } from '../utils/cost.js'
import type { ShopifyProduct } from '../shopify/types.js'
import type { QueryIntent, ScoringQuery } from '../scorer/types.js'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_COUNT = 50
const TIMEOUT_MS = 60_000
export const QUERIES_PROMPT_VERSION = 'queries.v1'

const SYSTEM_PROMPT = `You generate realistic shopper queries used to evaluate whether AI shopping agents (ChatGPT, Perplexity, Google AI Mode) surface a store's products.

REQUIREMENTS:
1. Each query must read like something a real person would actually type into an AI shopping assistant. Natural phrasing, realistic constraints.
2. Mix three intents roughly evenly across the set:
   - "purchase": ready to buy, usually with concrete constraints ("waterproof rain jacket under $200", "packable shell for backpacking")
   - "compare": weighing options ("rain jacket vs poncho for festivals", "softshell or hardshell for cycling")
   - "research": learning the category ("what to look for in a lightweight rain jacket", "are DWR coatings worth it")
3. Every query must legitimately match at least one product in the catalog. targetProductIds MUST be copied verbatim from the product ID list provided in the user message. Do NOT invent, guess, or modify IDs — if you can't find a real match, drop the query.
4. Cover the catalog broadly — no single product should appear in more than ~3 queries.
5. Do NOT mention brand names from the catalog in the query text. Shoppers search by attributes, not brand codenames.
6. category should be a short lowercase category label (e.g. "outerwear", "accessories").

OUTPUT FORMAT:
Return ONLY a JSON object (no markdown, no prose):
{ "queries": [ { "text": string, "category": string, "intent": "purchase" | "compare" | "research", "targetProductIds": string[] }, ... ] }
Each query's targetProductIds should contain 1-3 product IDs.`

export interface QueryGeneratorOptions {
  apiKey?: string
  model?: string
  promptVersion?: string
  dryRun?: boolean
}

export interface GenerateQueriesInput {
  products: ShopifyProduct[]
  count?: number
  storeCategory?: string
}

export class QueryValidationError extends Error {
  readonly raw: string
  constructor(message: string, raw: string) {
    super(message)
    this.name = 'QueryValidationError'
    this.raw = raw
  }
}

export class QueryGenerator {
  private client?: Anthropic
  private model: string
  private promptVersion: string
  private dryRun: boolean
  // Token cost of the most recent generate() call. Read by the loop / CLI
  // after each call so it can charge the budget for query generation.
  lastCostUsd = 0

  constructor(options: QueryGeneratorOptions) {
    this.dryRun = options.dryRun ?? false
    if (!this.dryRun) {
      if (!options.apiKey) {
        throw new Error('QueryGenerator requires apiKey unless dryRun is true')
      }
      this.client = new Anthropic({ apiKey: options.apiKey })
    }
    this.model = options.model ?? DEFAULT_MODEL
    this.promptVersion = options.promptVersion ?? QUERIES_PROMPT_VERSION
  }

  get version(): string {
    return this.promptVersion
  }

  async generate(input: GenerateQueriesInput): Promise<ScoringQuery[]> {
    const count = input.count ?? DEFAULT_COUNT
    if (this.dryRun) {
      this.lastCostUsd = 0
      return loadFixtureQueries(input.products, count)
    }
    const userPrompt = buildUserPrompt(input.products, count, input.storeCategory)
    const client = this.client!

    const response = await retry(
      () =>
        client.messages.create(
          {
            model: this.model,
            // ~80 tokens per query (text + 1-3 ids + intent + category) ×
            // 50 queries comfortably blew through 4096 and produced a
            // truncated JSON tail. 16384 leaves plenty of headroom.
            max_tokens: 16384,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
          },
          { timeout: TIMEOUT_MS },
        ),
      { attempts: 3, baseDelayMs: 1000 },
    )

    this.lastCostUsd = estimateCost(`anthropic:${this.model}`, {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
    })

    const raw = extractText(response)
    if (response.stop_reason === 'max_tokens') {
      throw new QueryValidationError(
        `Query generation hit max_tokens (${response.usage?.output_tokens ?? '?'} output tokens) and was truncated. Lower the requested count or raise max_tokens.`,
        raw,
      )
    }
    const parsed = parseJsonObject(raw)
    return buildQueries(parsed, input.products, count, raw)
  }
}

function buildUserPrompt(
  products: ShopifyProduct[],
  count: number,
  storeCategory: string | undefined,
): string {
  const productIds = products.map((p) => p.id)
  const productLines = products
    .map((p) => {
      const type = p.productType ?? 'product'
      const tags = p.tags.slice(0, 5).join(', ')
      return `  - ${p.id} :: ${p.title} [${type}]${tags ? ` — tags: ${tags}` : ''}`
    })
    .join('\n')

  const lines: string[] = []
  if (storeCategory) lines.push(`Catalog category: ${storeCategory}`)
  lines.push(
    'Product IDs (copy EXACTLY; do not invent):',
    JSON.stringify(productIds),
    '',
    `Generate ${count} shopper queries for this catalog:`,
    productLines,
    '',
    'Return the JSON object described in the instructions.',
  )
  return lines.join('\n')
}

function extractText(response: Anthropic.Message): string {
  const parts: string[] = []
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new QueryValidationError(`Query output was not valid JSON: ${message}`, raw)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new QueryValidationError('Query output was not a JSON object', raw)
  }
  return parsed as Record<string, unknown>
}

const VALID_INTENTS: readonly QueryIntent[] = ['purchase', 'compare', 'research']

function buildQueries(
  obj: Record<string, unknown>,
  products: ShopifyProduct[],
  expected: number,
  raw: string,
): ScoringQuery[] {
  const rawQueries = obj.queries
  if (!Array.isArray(rawQueries)) {
    throw new QueryValidationError('Expected `queries` to be an array', raw)
  }

  const productIds = new Set(products.map((p) => p.id))
  const result: ScoringQuery[] = []
  let droppedHallucinated = 0

  for (let i = 0; i < rawQueries.length; i++) {
    const item = rawQueries[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new QueryValidationError(`queries[${i}] is not an object`, raw)
    }
    const q = item as Record<string, unknown>
    const text = q.text
    const category = q.category
    const intent = q.intent
    const targetProductIds = q.targetProductIds

    if (typeof text !== 'string' || !text) {
      throw new QueryValidationError(`queries[${i}].text missing`, raw)
    }
    if (typeof category !== 'string' || !category) {
      throw new QueryValidationError(`queries[${i}].category missing`, raw)
    }
    if (typeof intent !== 'string' || !(VALID_INTENTS as readonly string[]).includes(intent)) {
      throw new QueryValidationError(`queries[${i}].intent invalid: ${String(intent)}`, raw)
    }
    if (
      !Array.isArray(targetProductIds) ||
      !targetProductIds.every((x) => typeof x === 'string')
    ) {
      throw new QueryValidationError(
        `queries[${i}].targetProductIds must be a string array`,
        raw,
      )
    }
    // The model occasionally hallucinates product GIDs that aren't in the
    // catalog. Filter those out instead of failing the whole batch — drop
    // the query only if nothing valid is left.
    const validIds = (targetProductIds as string[]).filter((id) => productIds.has(id))
    if (validIds.length === 0) {
      droppedHallucinated++
      continue
    }

    result.push({
      id: nanoid(),
      text,
      category,
      intent: intent as QueryIntent,
      targetProductIds: validIds,
    })
  }

  if (result.length === 0) {
    throw new QueryValidationError(
      `No valid queries produced (dropped ${droppedHallucinated} with hallucinated product IDs)`,
      raw,
    )
  }
  if (droppedHallucinated > 0) {
    console.warn(
      `[queries] dropped ${droppedHallucinated} of ${rawQueries.length} queries — model hallucinated product IDs not in catalog`,
    )
  }
  return result.slice(0, expected)
}

interface FixtureQuery {
  id?: string
  text: string
  category: string
  intent: string
  targetProductIds?: string[]
}

// Read the pre-generated demo queries from the repo fixture and re-home
// their targetProductIds onto whatever products the caller actually has.
// The fixture ships with targetProductIds: [] — it was authored before
// any specific store existed — so we round-robin real GIDs across the
// fixture entries so the loop's product-selection logic still has
// targeted queries to work with.
function loadFixtureQueries(products: ShopifyProduct[], count: number): ScoringQuery[] {
  if (products.length === 0) {
    throw new Error('loadFixtureQueries: at least one product is required to assign target IDs')
  }
  const fixturePath = new URL(
    '../../../../fixtures/demo-store/queries.json',
    import.meta.url,
  )
  const raw = readFileSync(fixturePath, 'utf-8')
  const parsed = JSON.parse(raw) as FixtureQuery[]
  const take = Math.min(count, parsed.length)
  const out: ScoringQuery[] = []
  for (let i = 0; i < take; i++) {
    const src = parsed[i]
    const intent = (VALID_INTENTS as readonly string[]).includes(src.intent)
      ? (src.intent as QueryIntent)
      : 'purchase'
    // Round-robin one real product ID onto each fixture query so the
    // loop sees a fully-targeted set.
    const target = products[i % products.length].id
    out.push({
      id: src.id ?? nanoid(),
      text: src.text,
      category: src.category,
      intent,
      targetProductIds: [target],
    })
  }
  return out
}
