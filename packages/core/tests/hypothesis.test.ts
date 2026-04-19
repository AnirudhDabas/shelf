import { describe, expect, it } from 'vitest'
import { HypothesisGenerator, HypothesisValidationError } from '../src/hypothesis/generator.js'
import type { ShopifyProduct } from '../src/shopify/types.js'

function product(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: 'gid://shopify/Product/1',
    title: 'Rain jacket',
    descriptionHtml: '<p>Waterproof shell for daily use.</p>',
    productType: 'Outerwear',
    vendor: 'TestBrand',
    tags: [],
    seo: { title: null, description: null },
    metafields: [],
    variants: [
      { id: 'gid://shopify/ProductVariant/99', title: 'Small', price: '40.00', availableForSale: true },
    ],
    images: [],
    ...overrides,
  }
}

function stubClient(text: string) {
  return {
    messages: {
      async create() {
        return { content: [{ type: 'text', text }] }
      },
    },
  }
}

function makeGenerator(text: string): HypothesisGenerator {
  const gen = new HypothesisGenerator({ apiKey: 'test-key' })
  ;(gen as unknown as { client: unknown }).client = stubClient(text)
  return gen
}

const validPayload = {
  type: 'title_rewrite',
  field: 'title',
  before: 'Rain jacket',
  after: 'Packable waterproof rain jacket',
  description: 'lead with category',
  reasoning: 'AI shoppers search by category',
  queryFailurePatterns: ['no match on "waterproof jacket"'],
  predictedEffect: 'higher match rate',
  riskLevel: 'low',
  confidence: 'medium',
  estimatedImpact: '+3 points',
}

describe('HypothesisGenerator.generate', () => {
  it('parses a well-formed JSON payload into a Hypothesis with all SPEC fields', async () => {
    const gen = makeGenerator(JSON.stringify(validPayload))
    const result = await gen.generate({
      product: product(),
      failedQueries: [],
      triedHypotheses: [],
    })
    expect(result.type).toBe('title_rewrite')
    expect(result.productId).toBe('gid://shopify/Product/1')
    expect(result.promptVersion).toBe('hypothesis.v1')
    expect(result.id).toBeDefined()
    expect(result.queryFailurePatterns).toEqual(['no match on "waterproof jacket"'])
    expect(result.riskLevel).toBe('low')
  })

  it('strips fenced markdown code blocks before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify(validPayload) + '\n```'
    const gen = makeGenerator(fenced)
    const result = await gen.generate({
      product: product(),
      failedQueries: [],
      triedHypotheses: [],
    })
    expect(result.type).toBe('title_rewrite')
  })

  it('throws HypothesisValidationError on invalid JSON', async () => {
    const gen = makeGenerator('not json at all')
    await expect(
      gen.generate({ product: product(), failedQueries: [], triedHypotheses: [] }),
    ).rejects.toBeInstanceOf(HypothesisValidationError)
  })

  it('throws on an unknown hypothesis type', async () => {
    const bad = { ...validPayload, type: 'totally_invented_type' }
    const gen = makeGenerator(JSON.stringify(bad))
    await expect(
      gen.generate({ product: product(), failedQueries: [], triedHypotheses: [] }),
    ).rejects.toThrow(/Invalid hypothesis type/)
  })

  it('throws when queryFailurePatterns is missing or not a string array', async () => {
    const bad = { ...validPayload, queryFailurePatterns: 'not an array' }
    const gen = makeGenerator(JSON.stringify(bad))
    await expect(
      gen.generate({ product: product(), failedQueries: [], triedHypotheses: [] }),
    ).rejects.toThrow(/queryFailurePatterns/)
  })

  it('throws when riskLevel is not low | medium | high', async () => {
    const bad = { ...validPayload, riskLevel: 'extreme' }
    const gen = makeGenerator(JSON.stringify(bad))
    await expect(
      gen.generate({ product: product(), failedQueries: [], triedHypotheses: [] }),
    ).rejects.toThrow(/riskLevel/)
  })

  it('requires variantId for variant_title and validates it exists on the product', async () => {
    const noVariant = { ...validPayload, type: 'variant_title' }
    const gen1 = makeGenerator(JSON.stringify(noVariant))
    await expect(
      gen1.generate({ product: product(), failedQueries: [], triedHypotheses: [] }),
    ).rejects.toThrow(/variantId/)

    const wrongVariant = { ...validPayload, type: 'variant_title', variantId: 'gid://shopify/ProductVariant/does-not-exist' }
    const gen2 = makeGenerator(JSON.stringify(wrongVariant))
    await expect(
      gen2.generate({ product: product(), failedQueries: [], triedHypotheses: [] }),
    ).rejects.toThrow(/does not exist/)
  })

  it('requires metafield namespace, key, and type for metafield_add', async () => {
    const bad = { ...validPayload, type: 'metafield_add' }
    const gen = makeGenerator(JSON.stringify(bad))
    await expect(
      gen.generate({ product: product(), failedQueries: [], triedHypotheses: [] }),
    ).rejects.toThrow(/metafieldNamespace/)
  })

  it('accepts variant_title when variantId matches an existing variant', async () => {
    const good = {
      ...validPayload,
      type: 'variant_title',
      variantId: 'gid://shopify/ProductVariant/99',
    }
    const gen = makeGenerator(JSON.stringify(good))
    const result = await gen.generate({
      product: product(),
      failedQueries: [],
      triedHypotheses: [],
    })
    expect(result.variantId).toBe('gid://shopify/ProductVariant/99')
  })
})
