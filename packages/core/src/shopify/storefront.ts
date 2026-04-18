import { createStorefrontApiClient } from '@shopify/storefront-api-client'
import { retry } from '../utils/retry.js'
import { STOREFRONT_GET_PRODUCTS } from './queries.js'

export interface StorefrontProduct {
  id: string
  handle: string
  title: string
  description: string
  productType: string | null
  vendor: string | null
  tags: string[]
  onlineStoreUrl: string | null
}

export interface StorefrontClientOptions {
  storeDomain: string
  publicAccessToken: string
  apiVersion?: string
}

export class ShopifyStorefrontClient {
  private client: ReturnType<typeof createStorefrontApiClient>

  constructor(options: StorefrontClientOptions) {
    this.client = createStorefrontApiClient({
      storeDomain: options.storeDomain,
      publicAccessToken: options.publicAccessToken,
      apiVersion: options.apiVersion ?? '2025-01',
    })
  }

  async listProducts(first = 50): Promise<StorefrontProduct[]> {
    return retry(async () => {
      const response = await this.client.request<{
        products: { edges: Array<{ node: StorefrontProduct }> }
      }>(STOREFRONT_GET_PRODUCTS, { variables: { first } })

      if (response.errors) {
        throw new Error(`Shopify Storefront API error: ${response.errors.message}`)
      }
      if (!response.data) {
        throw new Error('Shopify Storefront API returned no data')
      }
      return response.data.products.edges.map((e) => e.node)
    })
  }
}
