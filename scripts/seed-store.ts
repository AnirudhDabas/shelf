/**
 * Seed a Shopify dev store with the demo rain-gear catalog.
 *
 * Usage: pnpm tsx scripts/seed-store.ts
 *
 * Env required:
 *   SHOPIFY_STORE_DOMAIN      e.g. shelf-demo.myshopify.com
 *   SHOPIFY_ADMIN_ACCESS_TOKEN
 *
 * The catalog is intentionally bad for AI discovery — branded marketing
 * titles, fluffy descriptions, no metafields. shelf's job is to improve it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createAdminApiClient } from '@shopify/admin-api-client'

interface FixtureProduct {
  title: string
  descriptionHtml: string
  vendor: string
  productType: string
  tags: string[]
  price: string
  sizes: string[]
  image: string
}

const PRODUCT_CREATE = /* GraphQL */ `
  mutation ProductCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
    productCreate(input: $input, media: $media) {
      product {
        id
        title
        variants(first: 10) {
          edges {
            node {
              id
              title
              price
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`

const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`

interface ProductCreateResponse {
  productCreate: {
    product: {
      id: string
      title: string
      variants: { edges: Array<{ node: { id: string; title: string; price: string } }> }
    } | null
    userErrors: Array<{ field: string[] | null; message: string }>
  }
}

interface VariantsBulkUpdateResponse {
  productVariantsBulkUpdate: {
    productVariants: Array<{ id: string; price: string }> | null
    userErrors: Array<{ field: string[] | null; message: string }>
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`missing required env ${name}`)
    process.exit(1)
  }
  return v
}

async function main() {
  const storeDomain = requireEnv('SHOPIFY_STORE_DOMAIN')
  const accessToken = requireEnv('SHOPIFY_ADMIN_ACCESS_TOKEN')

  const fixturesPath = resolve(process.cwd(), 'fixtures/demo-store/products.json')
  const products = JSON.parse(readFileSync(fixturesPath, 'utf-8')) as FixtureProduct[]

  const client = createAdminApiClient({
    storeDomain,
    accessToken,
    apiVersion: '2025-01',
  })

  console.log(`seeding ${products.length} products into ${storeDomain}…`)

  let created = 0
  let failed = 0

  for (const [i, p] of products.entries()) {
    const label = `[${String(i + 1).padStart(2, '0')}/${products.length}] ${p.title}`
    try {
      const createRes = await client.request<ProductCreateResponse>(PRODUCT_CREATE, {
        variables: {
          input: {
            title: p.title,
            descriptionHtml: p.descriptionHtml,
            vendor: p.vendor,
            productType: p.productType,
            tags: p.tags,
            productOptions: [
              {
                name: 'Size',
                values: p.sizes.map((s) => ({ name: s })),
              },
            ],
          },
          media: [
            {
              mediaContentType: 'IMAGE',
              originalSource: p.image,
              alt: p.title,
            },
          ],
        },
      })

      if (createRes.errors) {
        throw new Error(createRes.errors.message)
      }

      const product = createRes.data?.productCreate.product
      const userErrors = createRes.data?.productCreate.userErrors ?? []
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join('; '))
      }
      if (!product) throw new Error('no product returned')

      const variantUpdates = product.variants.edges.map((edge) => ({
        id: edge.node.id,
        price: p.price,
      }))

      if (variantUpdates.length > 0) {
        const updateRes = await client.request<VariantsBulkUpdateResponse>(VARIANTS_BULK_UPDATE, {
          variables: { productId: product.id, variants: variantUpdates },
        })
        if (updateRes.errors) {
          throw new Error(updateRes.errors.message)
        }
        const updateErrors = updateRes.data?.productVariantsBulkUpdate.userErrors ?? []
        if (updateErrors.length > 0) {
          throw new Error(updateErrors.map((e) => e.message).join('; '))
        }
      }

      created++
      console.log(`${label} — ok`)
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${label} — FAILED: ${msg}`)
    }
  }

  console.log(`\ndone. created=${created} failed=${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
