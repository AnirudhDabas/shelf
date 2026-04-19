import { describe, expect, it } from 'vitest'
import { checkHypothesis } from '../src/checks/backpressure.js'
import type { Hypothesis } from '../src/hypothesis/types.js'
import type { ShopifyProduct } from '../src/shopify/types.js'

function baseProduct(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: 'gid://shopify/Product/1',
    title: 'Recycled polyester rain jacket',
    descriptionHtml:
      '<p>A packable waterproof rain jacket designed for outdoor travel and daily urban commutes. Constructed from recycled polyester with fully taped seams. Lightweight and breathable, suitable for hiking and wet weather conditions.</p>',
    productType: 'Outerwear',
    vendor: 'TestBrand',
    tags: ['rain', 'jacket', 'outdoor'],
    seo: { title: null, description: null },
    metafields: [],
    variants: [],
    images: [],
    ...overrides,
  }
}

function baseHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    type: 'title_rewrite',
    productId: 'gid://shopify/Product/1',
    productTitle: 'Recycled polyester rain jacket',
    field: 'title',
    before: 'Recycled polyester rain jacket',
    after: 'Packable waterproof rain jacket for outdoor travel',
    description: 'clarify category and use case',
    reasoning: 'AI shoppers search by category first',
    queryFailurePatterns: [],
    predictedEffect: 'higher surface rate',
    riskLevel: 'low',
    confidence: 'medium',
    estimatedImpact: '+3',
    promptVersion: 'hypothesis.v1',
    ...overrides,
  }
}

describe('checkHypothesis', () => {
  it('passes a normal title rewrite', () => {
    const result = checkHypothesis(baseHypothesis(), baseProduct())
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('fails when title exceeds 255 characters', () => {
    const longTitle = 'a'.repeat(256)
    const result = checkHypothesis(baseHypothesis({ after: longTitle }), baseProduct())
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('title too long'))).toBe(true)
  })

  it('fails when a keyword appears more than three times in title + description', () => {
    const spammyTitle = 'waterproof waterproof waterproof waterproof jacket brand'
    const result = checkHypothesis(baseHypothesis({ after: spammyTitle }), baseProduct())
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('waterproof'))).toBe(true)
  })

  it('fails when description reading grade is too high', () => {
    const product = baseProduct({
      descriptionHtml:
        '<p>Incomprehensibly supercalifragilistic thermoregulatory garment consisting predominantly of hydrophobically modified polyterephthalate oligomers assembled interstitially with metallotextile composites demonstrating unprecedented microclimatic modulation characteristics throughout prolonged transcontinental expeditionary undertakings.</p>',
    })
    const result = checkHypothesis(baseHypothesis(), product)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('reading grade'))).toBe(true)
  })

  it('fails when title starts with a spammy word', () => {
    const result = checkHypothesis(
      baseHypothesis({ after: 'Buy the best packable rain jacket today' }),
      baseProduct(),
    )
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.toLowerCase().includes('spammy'))).toBe(true)
  })

  it('fails when title contains an ALL CAPS word longer than 4 letters', () => {
    const result = checkHypothesis(
      baseHypothesis({ after: 'Premium AMAZING rain jacket' }),
      baseProduct(),
    )
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('AMAZING'))).toBe(true)
  })

  it('allows short acronyms up to 4 letters', () => {
    const result = checkHypothesis(
      baseHypothesis({ after: 'USA made rain jacket for travel' }),
      baseProduct(),
    )
    expect(result.passed).toBe(true)
  })

  it('fails metafield_add when value is not grounded in product data', () => {
    const hypothesis = baseHypothesis({
      type: 'metafield_add',
      field: 'custom.material',
      after: 'GORE-TEX laminate with proprietary DryMax membrane',
      metafieldNamespace: 'custom',
      metafieldKey: 'material',
      metafieldType: 'single_line_text_field',
    })
    const result = checkHypothesis(hypothesis, baseProduct())
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.toLowerCase().includes('metafield value'))).toBe(true)
  })

  it('passes metafield_add when at least one substantive token appears in product data', () => {
    const hypothesis = baseHypothesis({
      type: 'metafield_add',
      field: 'custom.material',
      after: 'recycled polyester shell',
      metafieldNamespace: 'custom',
      metafieldKey: 'material',
      metafieldType: 'single_line_text_field',
    })
    const result = checkHypothesis(hypothesis, baseProduct())
    expect(result.passed).toBe(true)
  })
})
