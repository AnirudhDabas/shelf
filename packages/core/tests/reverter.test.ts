import { describe, expect, it } from 'vitest'
import {
  HypothesisReverter,
  HypothesisRevertError,
} from '../src/hypothesis/reverter.js'
import type { ShopifyAdminClient } from '../src/shopify/admin.js'
import type {
  MetafieldIdentifierInput,
  MetafieldsSetInput,
  ProductUpdateInput,
} from '../src/shopify/types.js'
import type { ApplyResult, FieldChange, HypothesisType } from '../src/hypothesis/types.js'

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

function applied(
  type: HypothesisType,
  changes: FieldChange[],
  overrides: Partial<ApplyResult> = {},
): ApplyResult {
  return {
    hypothesisId: `h-${type}`,
    type,
    productId: 'gid://shopify/Product/42',
    changes,
    response: {},
    appliedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('HypothesisReverter', () => {
  describe('live writes — restores original value for each hypothesis type', () => {
    it('title_rewrite — sends updateProduct with the original title', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await reverter.revert(
        applied('title_rewrite', [
          { field: 'title', oldValue: 'Original', newValue: 'Changed' },
        ]),
      )
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', title: 'Original' },
      })
    })

    it('description_restructure — restores descriptionHtml', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await reverter.revert(
        applied('description_restructure', [
          { field: 'descriptionHtml', oldValue: '<p>old</p>', newValue: '<p>new</p>' },
        ]),
      )
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', descriptionHtml: '<p>old</p>' },
      })
    })

    it('seo_title — restores seo.title', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await reverter.revert(
        applied('seo_title', [
          { field: 'seo.title', oldValue: 'Old SEO', newValue: 'New SEO' },
        ]),
      )
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', seo: { title: 'Old SEO' } },
      })
    })

    it('seo_description — restores seo.description', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await reverter.revert(
        applied('seo_description', [
          { field: 'seo.description', oldValue: 'Old SEO desc', newValue: 'New SEO desc' },
        ]),
      )
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: {
          id: 'gid://shopify/Product/42',
          seo: { description: 'Old SEO desc' },
        },
      })
    })

    it('tags_update — re-parses old comma list back into array', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await reverter.revert(
        applied('tags_update', [
          { field: 'tags', oldValue: 'a, b, c', newValue: 'x, y' },
        ]),
      )
      expect(calls[0]).toEqual({
        method: 'updateProduct',
        args: { id: 'gid://shopify/Product/42', tags: ['a', 'b', 'c'] },
      })
    })

    it('metafield_add — calls deleteMetafields (since previous value was empty)', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await reverter.revert(
        applied(
          'metafield_add',
          [
            {
              field: 'metafields.shelf.features',
              oldValue: '',
              newValue: 'waterproof',
            },
          ],
          {
            metafieldNamespace: 'shelf',
            metafieldKey: 'features',
            metafieldType: 'multi_line_text_field',
          },
        ),
      )
      expect(calls[0]).toEqual({
        method: 'deleteMetafields',
        args: [
          {
            ownerId: 'gid://shopify/Product/42',
            namespace: 'shelf',
            key: 'features',
          },
        ],
      })
    })

    it('metafield_update — calls setMetafields with the original value', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await reverter.revert(
        applied(
          'metafield_update',
          [
            {
              field: 'metafields.shelf.features',
              oldValue: 'previous value',
              newValue: 'new value',
            },
          ],
          {
            metafieldNamespace: 'shelf',
            metafieldKey: 'features',
            metafieldType: 'single_line_text_field',
          },
        ),
      )
      expect(calls[0]).toEqual({
        method: 'setMetafields',
        args: [
          {
            ownerId: 'gid://shopify/Product/42',
            namespace: 'shelf',
            key: 'features',
            type: 'single_line_text_field',
            value: 'previous value',
          },
        ],
      })
    })

    it('metafield_add — throws when namespace/key missing on the apply result', async () => {
      const { admin } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await expect(
        reverter.revert(
          applied('metafield_add', [
            { field: 'metafields.shelf.features', oldValue: '', newValue: 'x' },
          ]),
        ),
      ).rejects.toBeInstanceOf(HypothesisRevertError)
    })

    it('throws when ApplyResult has no changes', async () => {
      const { admin } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      await expect(
        reverter.revert(applied('title_rewrite', [])),
      ).rejects.toBeInstanceOf(HypothesisRevertError)
    })
  })

  describe('round-trip with applier', () => {
    it('reverter returns oldValue/newValue swapped on each restored change', async () => {
      const { admin } = fakeAdmin()
      const reverter = new HypothesisReverter(admin)
      const result = await reverter.revert(
        applied('title_rewrite', [
          { field: 'title', oldValue: 'A', newValue: 'B' },
        ]),
      )
      expect(result.restoredChanges).toEqual([
        { field: 'title', oldValue: 'B', newValue: 'A' },
      ])
    })
  })

  describe('dry-run mode', () => {
    it('makes no admin calls and tags response as dryRun', async () => {
      const { admin, calls } = fakeAdmin()
      const reverter = new HypothesisReverter(admin, { dryRun: true })
      const result = await reverter.revert(
        applied('title_rewrite', [
          { field: 'title', oldValue: 'A', newValue: 'B' },
        ]),
      )
      expect(calls).toHaveLength(0)
      expect(result.response).toEqual({ dryRun: true })
      expect(result.restoredChanges[0].newValue).toBe('A')
    })
  })
})
