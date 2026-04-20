import Anthropic from '@anthropic-ai/sdk'
import { nanoid } from 'nanoid'
import { retry } from '../utils/retry.js'
import { estimateCost } from '../utils/cost.js'
import type { ShopifyProduct } from '../shopify/types.js'
import type { Hypothesis, HypothesisLevel, HypothesisType } from './types.js'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const TIMEOUT_MS = 30_000
export const HYPOTHESIS_PROMPT_VERSION = 'hypothesis.v1'

const SYSTEM_PROMPT = `You are an AI catalog optimization specialist. Your job is to propose ONE small, specific, atomic change to a Shopify product that will make it more likely to be surfaced by AI shopping agents (ChatGPT, Perplexity, Google AI Mode).

RULES:
1. ONE change per proposal. Never batch multiple changes.
2. Changes must be factually accurate — never fabricate product attributes.
3. Prefer adding structured data (metafields, clear attributes) over rewriting prose.
4. Product titles should lead with the product type, not the brand name.
   BAD: "The Explorer Pro" → GOOD: "Packable Rain Jacket — Men's Ultralight Waterproof Shell | BrandName"
5. Descriptions should be structured for machine parsing:
   - Lead with what the product IS (category, type)
   - Include material, dimensions, weight, use cases
   - Use natural language a shopper would search for
   - Avoid marketing fluff ("revolutionary", "game-changing")
6. Never keyword-stuff. Write naturally.
7. Metafields should use Shopify's standard taxonomy where possible.
8. Consider what a shopper would ACTUALLY type into ChatGPT when looking for this product.

OUTPUT FORMAT:
Return ONLY a JSON object with this exact shape (no markdown, no prose):
{
  "type": "title_rewrite" | "description_restructure" | "metafield_add" | "metafield_update" | "seo_title" | "seo_description" | "tags_update" | "variant_title",
  "field": string,
  "before": string,
  "after": string,
  "description": string,
  "reasoning": string,
  "queryFailurePatterns": string[],
  "predictedEffect": string,
  "riskLevel": "low" | "medium" | "high",
  "confidence": "low" | "medium" | "high",
  "estimatedImpact": string,
  "variantId"?: string,
  "metafieldNamespace"?: string,
  "metafieldKey"?: string,
  "metafieldType"?: string
}

For variant_title, variantId is REQUIRED and must match an existing variant GID from the product.
For metafield_add and metafield_update, metafieldNamespace, metafieldKey, and metafieldType are REQUIRED.
For tags_update, express "after" as a comma-separated list of the FULL tag set (not a diff).`

export interface GenerateHypothesisInput {
  product: ShopifyProduct
  failedQueries: Array<{ id: string; text: string; intent: string }>
  triedHypotheses: Array<Pick<Hypothesis, 'type' | 'field' | 'after'>>
  storeCategory?: string
}

export interface HypothesisGeneratorOptions {
  apiKey?: string
  model?: string
  promptVersion?: string
  dryRun?: boolean
}

export class HypothesisValidationError extends Error {
  readonly raw: string
  constructor(message: string, raw: string) {
    super(message)
    this.name = 'HypothesisValidationError'
    this.raw = raw
  }
}

export class HypothesisGenerator {
  private client?: Anthropic
  private model: string
  private promptVersion: string
  private dryRun: boolean
  // Token cost of the most recent generate() call. Read by the loop after
  // each call so it can charge the budget for hypothesis generation.
  lastCostUsd = 0

  constructor(options: HypothesisGeneratorOptions) {
    this.dryRun = options.dryRun ?? false
    if (!this.dryRun) {
      if (!options.apiKey) {
        throw new Error('HypothesisGenerator requires apiKey unless dryRun is true')
      }
      this.client = new Anthropic({ apiKey: options.apiKey })
    }
    this.model = options.model ?? DEFAULT_MODEL
    this.promptVersion = options.promptVersion ?? HYPOTHESIS_PROMPT_VERSION
  }

  async generate(input: GenerateHypothesisInput): Promise<Hypothesis> {
    if (this.dryRun) {
      this.lastCostUsd = 0
      return buildDryRunHypothesis(input.product, this.promptVersion)
    }
    const userPrompt = buildUserPrompt(input)
    const client = this.client!
    const response = await retry(
      () =>
        client.messages.create(
          {
            model: this.model,
            max_tokens: 2048,
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
    const parsed = parseJsonObject(raw)
    return buildHypothesis(parsed, input.product, this.promptVersion, raw)
  }
}

function buildUserPrompt(input: GenerateHypothesisInput): string {
  const { product, failedQueries, triedHypotheses, storeCategory } = input

  const metafieldLines =
    product.metafields
      .map((m) => `  - ${m.namespace}.${m.key} (${m.type}): ${truncate(m.value, 120)}`)
      .join('\n') || '  (none)'

  const variantLines =
    product.variants
      .map((v) => `    - ${v.id} "${v.title}" $${v.price}`)
      .join('\n') || '    (none)'

  const failedLines = failedQueries.length
    ? failedQueries.map((q) => `  - [${q.intent}] ${q.text}`).join('\n')
    : '  (no failing queries known yet)'

  const triedLines = triedHypotheses.length
    ? triedHypotheses
        .map((h) => `  - ${h.type} on "${h.field}" → ${truncate(h.after, 80)}`)
        .join('\n')
    : '  (no prior attempts)'

  const lines: string[] = []
  if (storeCategory) lines.push(`Store category: ${storeCategory}`)
  lines.push(
    `Product (${product.id}):`,
    `  Title: ${product.title}`,
    `  Type: ${product.productType ?? '(unset)'}`,
    `  Vendor: ${product.vendor ?? '(unset)'}`,
    `  Tags: ${product.tags.join(', ') || '(none)'}`,
    `  SEO title: ${product.seo.title ?? '(unset)'}`,
    `  SEO description: ${product.seo.description ?? '(unset)'}`,
    `  Description HTML:`,
    indent(truncate(product.descriptionHtml, 1500), 4),
    `  Variants:`,
    variantLines,
    `  Metafields:`,
    metafieldLines,
    '',
    `Failing shopper queries for this product:`,
    failedLines,
    '',
    `Already-tried hypotheses for this product (do not repeat these changes):`,
    triedLines,
    '',
    `Propose ONE atomic change as a JSON object matching the schema.`,
  )
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n)}…`
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n)
  return s
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')
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
    throw new HypothesisValidationError(`Hypothesis output was not valid JSON: ${message}`, raw)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HypothesisValidationError('Hypothesis output was not a JSON object', raw)
  }
  return parsed as Record<string, unknown>
}

const VALID_TYPES: readonly HypothesisType[] = [
  'title_rewrite',
  'description_restructure',
  'metafield_add',
  'metafield_update',
  'seo_title',
  'seo_description',
  'tags_update',
  'variant_title',
]

const VALID_LEVELS: readonly HypothesisLevel[] = ['low', 'medium', 'high']

function requireString(obj: Record<string, unknown>, field: string, raw: string): string {
  const v = obj[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw new HypothesisValidationError(`Missing or invalid string field: ${field}`, raw)
  }
  return v
}

function optionalString(
  obj: Record<string, unknown>,
  field: string,
  raw: string,
): string | undefined {
  const v = obj[field]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') {
    throw new HypothesisValidationError(`Field ${field} must be a string if present`, raw)
  }
  return v
}

function requireType(obj: Record<string, unknown>, raw: string): HypothesisType {
  const v = obj.type
  if (typeof v !== 'string' || !(VALID_TYPES as readonly string[]).includes(v)) {
    throw new HypothesisValidationError(`Invalid hypothesis type: ${String(v)}`, raw)
  }
  return v as HypothesisType
}

function requireLevel(obj: Record<string, unknown>, field: string, raw: string): HypothesisLevel {
  const v = obj[field]
  if (typeof v !== 'string' || !(VALID_LEVELS as readonly string[]).includes(v)) {
    throw new HypothesisValidationError(`Invalid ${field}: ${String(v)}`, raw)
  }
  return v as HypothesisLevel
}

function requireStringArray(obj: Record<string, unknown>, field: string, raw: string): string[] {
  const v = obj[field]
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new HypothesisValidationError(`Field ${field} must be a string array`, raw)
  }
  return v as string[]
}

function buildHypothesis(
  obj: Record<string, unknown>,
  product: ShopifyProduct,
  promptVersion: string,
  raw: string,
): Hypothesis {
  const type = requireType(obj, raw)

  const hypothesis: Hypothesis = {
    id: nanoid(),
    type,
    productId: product.id,
    productTitle: product.title,
    field: requireString(obj, 'field', raw),
    before: typeof obj.before === 'string' ? obj.before : '',
    after: requireString(obj, 'after', raw),
    description: requireString(obj, 'description', raw),
    reasoning: requireString(obj, 'reasoning', raw),
    queryFailurePatterns: requireStringArray(obj, 'queryFailurePatterns', raw),
    predictedEffect: requireString(obj, 'predictedEffect', raw),
    riskLevel: requireLevel(obj, 'riskLevel', raw),
    confidence: requireLevel(obj, 'confidence', raw),
    estimatedImpact: requireString(obj, 'estimatedImpact', raw),
    promptVersion,
  }

  const variantId = optionalString(obj, 'variantId', raw)
  const metafieldNamespace = optionalString(obj, 'metafieldNamespace', raw)
  const metafieldKey = optionalString(obj, 'metafieldKey', raw)
  const metafieldType = optionalString(obj, 'metafieldType', raw)

  if (type === 'variant_title') {
    if (!variantId) {
      throw new HypothesisValidationError('variant_title requires variantId', raw)
    }
    if (!product.variants.some((v) => v.id === variantId)) {
      throw new HypothesisValidationError(
        `variantId ${variantId} does not exist on product ${product.id}`,
        raw,
      )
    }
    hypothesis.variantId = variantId
  }

  if (type === 'metafield_add' || type === 'metafield_update') {
    if (!metafieldNamespace || !metafieldKey || !metafieldType) {
      throw new HypothesisValidationError(
        `${type} requires metafieldNamespace, metafieldKey, and metafieldType`,
        raw,
      )
    }
    hypothesis.metafieldNamespace = metafieldNamespace
    hypothesis.metafieldKey = metafieldKey
    hypothesis.metafieldType = metafieldType
  }

  return hypothesis
}

function buildDryRunHypothesis(product: ShopifyProduct, promptVersion: string): Hypothesis {
  const type = product.productType ?? 'Jacket'
  const after = `Waterproof ${type} — ${product.title} | ${product.vendor ?? 'shelf'}`
  return {
    id: nanoid(),
    type: 'title_rewrite',
    productId: product.id,
    productTitle: product.title,
    field: 'title',
    before: product.title,
    after,
    description: 'lead title with product category and waterproofing keyword',
    reasoning: 'dry-run stub: shoppers search by category + attribute, not brand',
    queryFailurePatterns: ['waterproof', 'category'],
    predictedEffect: 'more matches on category + attribute queries',
    riskLevel: 'low',
    confidence: 'medium',
    estimatedImpact: '+3',
    promptVersion,
  }
}
