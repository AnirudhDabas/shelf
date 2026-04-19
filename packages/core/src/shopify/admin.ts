import { createAdminApiClient } from '@shopify/admin-api-client'
import { retry } from '../utils/retry.js'
import { GET_PRODUCT, GET_PRODUCTS } from './queries.js'
import {
  METAFIELDS_DELETE,
  METAFIELDS_SET,
  PRODUCT_UPDATE,
  PRODUCT_VARIANTS_BULK_UPDATE,
} from './mutations.js'
import type {
  MetafieldIdentifierInput,
  MetafieldsDeleteResponse,
  MetafieldsSetInput,
  MetafieldsSetResponse,
  ProductUpdateInput,
  ProductUpdateResponse,
  ProductVariantsBulkInput,
  ProductVariantsBulkUpdateResponse,
  ShopifyProduct,
} from './types.js'

type EdgesResponse<T> = { edges: Array<{ node: T }> }

interface RawProduct {
  id: string
  title: string
  descriptionHtml: string
  productType?: string | null
  vendor?: string | null
  tags: string[]
  seo: { title?: string | null; description?: string | null }
  metafields: EdgesResponse<{
    id: string
    key: string
    namespace: string
    value: string
    type: string
  }>
  variants: EdgesResponse<{
    id: string
    title: string
    price: string
    availableForSale: boolean
    sku?: string | null
  }>
  images: EdgesResponse<{ url: string; altText?: string | null }>
  onlineStoreUrl?: string | null
}

function normalizeProduct(raw: RawProduct): ShopifyProduct {
  return {
    id: raw.id,
    title: raw.title,
    descriptionHtml: raw.descriptionHtml,
    productType: raw.productType,
    vendor: raw.vendor,
    tags: raw.tags,
    seo: raw.seo,
    metafields: raw.metafields.edges.map((e) => ({
      id: e.node.id,
      key: e.node.key,
      namespace: e.node.namespace,
      value: e.node.value,
      type: e.node.type,
    })),
    variants: raw.variants.edges.map((e) => e.node),
    images: raw.images.edges.map((e) => e.node),
    onlineStoreUrl: raw.onlineStoreUrl,
  }
}

export interface AdminClientOptions {
  storeDomain: string
  accessToken: string
  apiVersion?: string
}

export class ShopifyAdminClient {
  private client: ReturnType<typeof createAdminApiClient>

  constructor(options: AdminClientOptions) {
    this.client = createAdminApiClient({
      storeDomain: options.storeDomain,
      accessToken: options.accessToken,
      apiVersion: options.apiVersion ?? '2025-01',
    })
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return retry(async () => {
      const response = await this.client.request<T>(query, { variables })
      if (response.errors) {
        const graphqlErrors = response.errors.graphQLErrors ?? []
        const messages = graphqlErrors.map((e) => e.message).join('; ')
        throw new Error(`Shopify Admin API error: ${messages || response.errors.message}`)
      }
      if (!response.data) {
        throw new Error('Shopify Admin API returned no data')
      }
      return response.data
    })
  }

  async listProducts(options: { pageSize?: number; max?: number } = {}): Promise<ShopifyProduct[]> {
    const pageSize = options.pageSize ?? 50
    const max = options.max ?? 250
    const products: ShopifyProduct[] = []
    let after: string | null = null

    while (products.length < max) {
      const data: {
        products: {
          edges: Array<{ node: RawProduct }>
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } = await this.request(GET_PRODUCTS, { first: pageSize, after })

      for (const edge of data.products.edges) {
        products.push(normalizeProduct(edge.node))
        if (products.length >= max) break
      }

      if (!data.products.pageInfo.hasNextPage) break
      after = data.products.pageInfo.endCursor
      if (!after) break
    }

    return products
  }

  async getProduct(id: string): Promise<ShopifyProduct | null> {
    const data = await this.request<{ product: RawProduct | null }>(GET_PRODUCT, { id })
    return data.product ? normalizeProduct(data.product) : null
  }

  async updateProduct(input: ProductUpdateInput): Promise<ProductUpdateResponse['productUpdate']> {
    const data = await this.request<ProductUpdateResponse>(PRODUCT_UPDATE, { input })
    if (data.productUpdate.userErrors.length > 0) {
      const msg = data.productUpdate.userErrors.map((e) => e.message).join('; ')
      throw new Error(`productUpdate userErrors: ${msg}`)
    }
    return data.productUpdate
  }

  async setMetafields(
    metafields: MetafieldsSetInput[],
  ): Promise<MetafieldsSetResponse['metafieldsSet']> {
    const data = await this.request<MetafieldsSetResponse>(METAFIELDS_SET, { metafields })
    if (data.metafieldsSet.userErrors.length > 0) {
      const msg = data.metafieldsSet.userErrors.map((e) => e.message).join('; ')
      throw new Error(`metafieldsSet userErrors: ${msg}`)
    }
    return data.metafieldsSet
  }

  async deleteMetafields(
    metafields: MetafieldIdentifierInput[],
  ): Promise<MetafieldsDeleteResponse['metafieldsDelete']> {
    const data = await this.request<MetafieldsDeleteResponse>(METAFIELDS_DELETE, { metafields })
    if (data.metafieldsDelete.userErrors.length > 0) {
      const msg = data.metafieldsDelete.userErrors.map((e) => e.message).join('; ')
      throw new Error(`metafieldsDelete userErrors: ${msg}`)
    }
    return data.metafieldsDelete
  }

  async updateVariants(
    productId: string,
    variants: ProductVariantsBulkInput[],
  ): Promise<ProductVariantsBulkUpdateResponse['productVariantsBulkUpdate']> {
    const data = await this.request<ProductVariantsBulkUpdateResponse>(
      PRODUCT_VARIANTS_BULK_UPDATE,
      { productId, variants },
    )
    if (data.productVariantsBulkUpdate.userErrors.length > 0) {
      const msg = data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ')
      throw new Error(`productVariantsBulkUpdate userErrors: ${msg}`)
    }
    return data.productVariantsBulkUpdate
  }
}
