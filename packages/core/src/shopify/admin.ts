import { createAdminApiClient } from '@shopify/admin-api-client'
import { retry } from '../utils/retry.js'
import { GET_PRODUCT, GET_PRODUCTS } from './queries.js'
import { METAFIELDS_DELETE, METAFIELDS_SET, PRODUCT_UPDATE } from './mutations.js'
import type {
  MetafieldIdentifierInput,
  MetafieldsDeleteResponse,
  MetafieldsSetInput,
  MetafieldsSetResponse,
  ProductUpdateInput,
  ProductUpdateResponse,
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

export interface AdminClientCreateOptions {
  storeDomain: string
  apiVersion?: string
  // Provide either a long-lived access token...
  accessToken?: string
  // ...or OAuth client credentials, in which case a fresh 24h token is fetched.
  clientId?: string
  clientSecret?: string
}

export interface ClientCredentials {
  storeDomain: string
  clientId: string
  clientSecret: string
}

// OAuth client_credentials grant. Returns a short-lived (~24h) access token
// suitable for the Admin GraphQL API. Used when the caller doesn't have a
// long-lived shpat_ token (e.g. managed installs / Plus stores).
export async function fetchAccessToken(creds: ClientCredentials): Promise<string> {
  const url = `https://${creds.storeDomain}/admin/oauth/access_token`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `Shopify OAuth client_credentials failed (${res.status} ${res.statusText}): ${text || '(no body)'}`,
    )
  }
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error('Shopify OAuth client_credentials returned no access_token')
  }
  return body.access_token
}

export class ShopifyAdminClient {
  private client: ReturnType<typeof createAdminApiClient>
  private readonly storeDomain: string
  private readonly apiVersion: string
  private credentials: { clientId: string; clientSecret: string } | null = null
  private refreshing: Promise<void> | null = null

  constructor(options: AdminClientOptions) {
    this.storeDomain = options.storeDomain
    this.apiVersion = options.apiVersion ?? '2026-04'
    this.client = createAdminApiClient({
      storeDomain: this.storeDomain,
      accessToken: options.accessToken,
      apiVersion: this.apiVersion,
    })
  }

  static async create(options: AdminClientCreateOptions): Promise<ShopifyAdminClient> {
    if (options.clientId && options.clientSecret) {
      const accessToken = await fetchAccessToken({
        storeDomain: options.storeDomain,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      })
      const client = new ShopifyAdminClient({
        storeDomain: options.storeDomain,
        accessToken,
        apiVersion: options.apiVersion,
      })
      // Retain creds so we can refresh on 401 mid-run (24h token TTL).
      client.credentials = { clientId: options.clientId, clientSecret: options.clientSecret }
      return client
    }
    if (options.accessToken) {
      return new ShopifyAdminClient({
        storeDomain: options.storeDomain,
        accessToken: options.accessToken,
        apiVersion: options.apiVersion,
      })
    }
    throw new Error(
      'ShopifyAdminClient.create: provide accessToken, or clientId + clientSecret',
    )
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.credentials) return
    // Coalesce concurrent refreshes so we don't fetch N tokens for N in-flight requests.
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const accessToken = await fetchAccessToken({
          storeDomain: this.storeDomain,
          clientId: this.credentials!.clientId,
          clientSecret: this.credentials!.clientSecret,
        })
        this.client = createAdminApiClient({
          storeDomain: this.storeDomain,
          accessToken,
          apiVersion: this.apiVersion,
        })
      })().finally(() => {
        this.refreshing = null
      })
    }
    await this.refreshing
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return retry(async () => {
      let response = await this.client.request<T>(query, { variables })
      if (response.errors?.networkStatusCode === 401 && this.credentials) {
        await this.refreshAccessToken()
        response = await this.client.request<T>(query, { variables })
      }
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
}
