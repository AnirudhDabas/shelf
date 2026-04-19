export interface ShopifyMetafield {
  id?: string
  namespace: string
  key: string
  value: string
  type: string
}

export interface ShopifyVariant {
  id: string
  title: string
  price: string
  availableForSale: boolean
  sku?: string | null
}

export interface ShopifyImage {
  url: string
  altText?: string | null
}

export interface ShopifyProduct {
  id: string
  title: string
  descriptionHtml: string
  productType?: string | null
  vendor?: string | null
  tags: string[]
  seo: {
    title?: string | null
    description?: string | null
  }
  metafields: ShopifyMetafield[]
  variants: ShopifyVariant[]
  images: ShopifyImage[]
  onlineStoreUrl?: string | null
}

export interface ProductUpdateInput {
  id: string
  title?: string
  descriptionHtml?: string
  seo?: {
    title?: string
    description?: string
  }
  tags?: string[]
}

export interface MetafieldsSetInput {
  ownerId: string
  namespace: string
  key: string
  value: string
  type: string
}

export interface MetafieldIdentifierInput {
  ownerId: string
  namespace: string
  key: string
}

export interface ProductVariantsBulkInput {
  id: string
  title?: string
  price?: string
}

export interface UserError {
  field: string[] | null
  message: string
}

export interface ProductUpdateResponse {
  productUpdate: {
    product: ShopifyProduct | null
    userErrors: UserError[]
  }
}

export interface MetafieldsSetResponse {
  metafieldsSet: {
    metafields: ShopifyMetafield[] | null
    userErrors: UserError[]
  }
}

export interface MetafieldsDeleteResponse {
  metafieldsDelete: {
    deletedMetafields: Array<{ key: string; namespace: string }> | null
    userErrors: UserError[]
  }
}

export interface ProductVariantsBulkUpdateResponse {
  productVariantsBulkUpdate: {
    productVariants: Array<{ id: string; title: string }> | null
    userErrors: UserError[]
  }
}
