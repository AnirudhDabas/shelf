import { describe, expect, it } from 'vitest'
import {
  HypothesisApplier,
  HypothesisApplyError,
} from '../src/hypothesis/applier.js'
import type { ShopifyAdminClient } from '../src/shopify/admin.js'
import type {
  MetafieldIdentifierInput,
  MetafieldsSetInput,
  ProductUpdateInput,
} from '../src/shopify/types.js'
import type { ShopifyProduct } from '../src/shopify/types.js'
import type { Hypothesis, HypothesisType } from '../src/hypothesis/types.js'

interface AdminCall {
  method: 'updateProduct' | 'setMetafields' | 'deleteMetafields'
  args: unknown
}

function fakeAdmin() {
  const calls: AdminCall[] = []
  const admin = {
    async updateProduct(input: ProductUpdateInput) {
      calls.push({ method: 'updateProduct', args: input })
      return { product: { id: input.id }, userErrors: [] }
    },
    async setMetafields(metafields: MetafieldsSetInput[]) {
      calls.push({ method: 'setMetafields', args: metafields })
      return { metafields, userErrors: [] }
    },
    async deleteMetafields(metafields: MetafieldIdentifierInput[]) {
      calls.push({ method: 'deleteMetafields', args: metafields })
      return { deletedMetafields: metafields, userErrors: [] }
    },
  }
  return { admin: admin as unknown as ShopifyAdminClient, calls }
}

function product(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: 'gid://shopify/Product/42',
    title: 'Old title',
    descriptionHtml: '<p>old</p>',
    productType: 'Outerwear',
    vendor: 'Acme',
    tags: ['old', 'tag'],
    seo: { title: 'Old SEO', description: 'Old SEO desc' },
    metafields: [],
    variants: [],
    images: [],
    ...overrides,
  }
}

function hypothesis(type: HypothesisType, overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: `h-${type}`,
    type,
    productId: 'gid://shopify/Product/42',
    productTitle: 'Old title',
    field: type,
    before: '',
    after: '',
    description: '',
    reasoning: '',
    queryFailurePatterns: [],
    predictedEffect: '',
    riskLevel: 'low',
    confidence: 'medium',
    estimatedImpact: '',
    promptVersion: 'hypothesis.v1',
    ...overrides,
  }
}

describe('HypothesisApplier', () => {
  describe('live writes', () => {
    it('title_rewrite — sends updateProduct with new title and records change', async () => {
      const { admin, calls } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('title_rewrite', { after: 'New crisp title' })
      const result = await applier.apply(h, product())
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', title: 'New crisp title' },
      })
      expect(result.changes).toEqual([
        { field: 'title', oldValue: 'Old title', newValue: 'New crisp title' },
      ])
      expect(result.hypothesisId).toBe('h-title_rewrite')
    })

    it('description_restructure — updates descriptionHtml', async () => {
      const { admin, calls } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('description_restructure', { after: '<p>new</p>' })
      const result = await applier.apply(h, product())
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', descriptionHtml: '<p>new</p>' },
      })
      expect(result.changes[0]).toEqual({
        field: 'descriptionHtml',
        oldValue: '<p>old</p>',
        newValue: '<p>new</p>',
      })
    })

    it('seo_title — updates seo.title', async () => {
      const { admin, calls } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('seo_title', { after: 'Better SEO title' })
      const result = await applier.apply(h, product())
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', seo: { title: 'Better SEO title' } },
      })
      expect(result.changes[0]).toEqual({
        field: 'seo.title',
        oldValue: 'Old SEO',
        newValue: 'Better SEO title',
      })
    })

    it('seo_description — updates seo.description', async () => {
      const { admin, calls } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('seo_description', { after: 'Better SEO desc' })
      const result = await applier.apply(h, product())
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: {
          id: 'gid://shopify/Product/42',
          seo: { description: 'Better SEO desc' },
        },
      })
      expect(result.changes[0]).toEqual({
        field: 'seo.description',
        oldValue: 'Old SEO desc',
        newValue: 'Better SEO desc',
      })
    })

    it('seo_title — handles null prior value gracefully', async () => {
      const { admin } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('seo_title', { after: 'X' })
      const result = await applier.apply(
        h,
        product({ seo: { title: null, description: null } }),
      )
      expect(result.changes[0].oldValue).toBe('')
    })

    it('tags_update — parses comma list, trims whitespace, drops empties', async () => {
      const { admin, calls } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('tags_update', { after: ' new , fresh ,, tags ' })
      const result = await applier.apply(h, product({ tags: ['old', 'tag'] }))
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', tags: ['new', 'fresh', 'tags'] },
      })
      expect(result.changes[0]).toEqual({
        field: 'tags',
        oldValue: 'old, tag',
        newValue: 'new, fresh, tags',
      })
    })

    it('metafield_add — sets new metafield with empty oldValue', async () => {
      const { admin, calls } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('metafield_add', {
        metafieldNamespace: 'shelf',
        metafieldKey: 'features',
        metafieldType: 'multi_line_text_field',
        after: 'waterproof\nlightweight',
      })
      const result = await applier.apply(h, product())
      expect(calls[0]).toEqual({
        method: 'setMetafields',
        args: [
          {
            ownerId: 'gid://shopify/Product/42',
            namespace: 'shelf',
            key: 'features',
            type: 'multi_line_text_field',
            value: 'waterproof\nlightweight',
          },
        ],
      })
      expect(result.changes[0]).toEqual({
        field: 'metafields.shelf.features',
        oldValue: '',
        newValue: 'waterproof\nlightweight',
      })
      expect(result.metafieldNamespace).toBe('shelf')
      expect(result.metafieldKey).toBe('features')
    })

    it('metafield_update — captures previous value as oldValue', async () => {
      const { admin } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('metafield_update', {
        metafieldNamespace: 'shelf',
        metafieldKey: 'features',
        metafieldType: 'single_line_text_field',
        after: 'updated value',
      })
      const result = await applier.apply(
        h,
        product({
          metafields: [
            {
              namespace: 'shelf',
              key: 'features',
              value: 'previous value',
              type: 'single_line_text_field',
            },
          ],
        }),
      )
      expect(result.changes[0]).toEqual({
        field: 'metafields.shelf.features',
        oldValue: 'previous value',
        newValue: 'updated value',
      })
    })

    it('metafield_add — throws when namespace/key/type missing', async () => {
      const { admin } = fakeAdmin()
      const applier = new HypothesisApplier(admin)
      const h = hypothesis('metafield_add', { after: 'x' })
      await expect(applier.apply(h, product())).rejects.toBeInstanceOf(HypothesisApplyError)
    })
  })

  describe('dry-run mode', () => {
    it('makes no admin calls and tags response as dryRun', async () => {
      const { admin, calls } = fakeAdmin()
      const applier = new HypothesisApplier(admin, { dryRun: true })
      const h = hypothesis('title_rewrite', { after: 'New' })
      const result = await applier.apply(h, product())
      expect(calls).toHaveLength(0)
      expect(result.response).toEqual({ dryRun: true })
      expect(result.changes[0]).toEqual({
        field: 'title',
        oldValue: 'Old title',
        newValue: 'New',
      })
    })

    it('preserves metafield identifiers in dry-run for round-trip revert', async () => {
      const { admin } = fakeAdmin()
      const applier = new HypothesisApplier(admin, { dryRun: true })
      const h = hypothesis('metafield_add', {
        metafieldNamespace: 'shelf',
        metafieldKey: 'features',
        metafieldType: 'multi_line_text_field',
        after: 'x',
      })
      const result = await applier.apply(h, product())
      expect(result.metafieldNamespace).toBe('shelf')
      expect(result.metafieldKey).toBe('features')
      expect(result.metafieldType).toBe('multi_line_text_field')
    })
  })
})
