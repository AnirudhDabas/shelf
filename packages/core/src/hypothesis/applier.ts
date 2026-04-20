import type { ShopifyAdminClient } from '../shopify/admin.js'
import type { MetafieldsSetInput, ShopifyProduct } from '../shopify/types.js'
import type { ApplyResult, FieldChange, Hypothesis } from './types.js'

export class HypothesisApplyError extends Error {
  readonly hypothesisId: string
  constructor(message: string, hypothesisId: string) {
    super(message)
    this.name = 'HypothesisApplyError'
    this.hypothesisId = hypothesisId
  }
}

export interface HypothesisApplierOptions {
  dryRun?: boolean
}

export class HypothesisApplier {
  private admin: ShopifyAdminClient
  private dryRun: boolean

  constructor(admin: ShopifyAdminClient, options: HypothesisApplierOptions = {}) {
    this.admin = admin
    this.dryRun = options.dryRun ?? false
  }

  async apply(h: Hypothesis, product: ShopifyProduct): Promise<ApplyResult> {
    if (this.dryRun) return applyDryRun(h, product)
    switch (h.type) {
      case 'title_rewrite':
        return this.applyTitle(h, product)
      case 'description_restructure':
        return this.applyDescription(h, product)
      case 'seo_title':
        return this.applySeoTitle(h, product)
      case 'seo_description':
        return this.applySeoDescription(h, product)
      case 'tags_update':
        return this.applyTags(h, product)
      case 'metafield_add':
      case 'metafield_update':
        return this.applyMetafield(h, product)
      case 'variant_title':
        return this.applyVariantTitle(h, product)
    }
  }

  private async applyTitle(h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> {
    const oldValue = p.title
    const response = await this.admin.updateProduct({ id: p.id, title: h.after })
    return baseResult(h, p.id, [change('title', oldValue, h.after)], response)
  }

  private async applyDescription(h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> {
    const oldValue = p.descriptionHtml
    const response = await this.admin.updateProduct({ id: p.id, descriptionHtml: h.after })
    return baseResult(h, p.id, [change('descriptionHtml', oldValue, h.after)], response)
  }

  private async applySeoTitle(h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> {
    const oldValue = p.seo.title ?? ''
    const response = await this.admin.updateProduct({ id: p.id, seo: { title: h.after } })
    return baseResult(h, p.id, [change('seo.title', oldValue, h.after)], response)
  }

  private async applySeoDescription(h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> {
    const oldValue = p.seo.description ?? ''
    const response = await this.admin.updateProduct({ id: p.id, seo: { description: h.after } })
    return baseResult(h, p.id, [change('seo.description', oldValue, h.after)], response)
  }

  private async applyTags(h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> {
    const oldValue = p.tags.join(', ')
    const newTags = parseTags(h.after)
    const newValue = newTags.join(', ')
    const response = await this.admin.updateProduct({ id: p.id, tags: newTags })
    return baseResult(h, p.id, [change('tags', oldValue, newValue)], response)
  }

  private async applyMetafield(h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> {
    if (!h.metafieldNamespace || !h.metafieldKey || !h.metafieldType) {
      throw new HypothesisApplyError(
        'metafield hypothesis missing namespace, key, or type',
        h.id,
      )
    }
    const existing = p.metafields.find(
      (m) => m.namespace === h.metafieldNamespace && m.key === h.metafieldKey,
    )
    const oldValue = existing?.value ?? ''
    const input: MetafieldsSetInput = {
      ownerId: p.id,
      namespace: h.metafieldNamespace,
      key: h.metafieldKey,
      type: h.metafieldType,
      value: h.after,
    }
    const response = await this.admin.setMetafields([input])
    const fieldName = `metafields.${h.metafieldNamespace}.${h.metafieldKey}`
    return {
      hypothesisId: h.id,
      type: h.type,
      productId: p.id,
      metafieldNamespace: h.metafieldNamespace,
      metafieldKey: h.metafieldKey,
      metafieldType: h.metafieldType,
      changes: [change(fieldName, oldValue, h.after)],
      response,
      appliedAt: new Date().toISOString(),
    }
  }

  private async applyVariantTitle(h: Hypothesis, p: ShopifyProduct): Promise<ApplyResult> {
    if (!h.variantId) {
      throw new HypothesisApplyError('variant_title hypothesis missing variantId', h.id)
    }
    const variant = p.variants.find((v) => v.id === h.variantId)
    if (!variant) {
      throw new HypothesisApplyError(
        `variant ${h.variantId} not found on product ${p.id}`,
        h.id,
      )
    }
    const oldValue = variant.title
    const response = await this.admin.updateVariants(p.id, [
      { id: h.variantId, title: h.after },
    ])
    return {
      hypothesisId: h.id,
      type: h.type,
      productId: p.id,
      variantId: h.variantId,
      changes: [change(`variants.${h.variantId}.title`, oldValue, h.after)],
      response,
      appliedAt: new Date().toISOString(),
    }
  }
}

function change(field: string, oldValue: string, newValue: string): FieldChange {
  return { field, oldValue, newValue }
}

function baseResult(
  h: Hypothesis,
  productId: string,
  changes: FieldChange[],
  response: unknown,
): ApplyResult {
  return {
    hypothesisId: h.id,
    type: h.type,
    productId,
    changes,
    response,
    appliedAt: new Date().toISOString(),
  }
}

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function applyDryRun(h: Hypothesis, product: ShopifyProduct): ApplyResult {
  console.log(
    `[dry-run] would apply ${h.type} to ${product.id} (${product.title}): "${truncateValue(h.after)}"`,
  )
  const changes: FieldChange[] = [
    change(fieldLabel(h), currentValue(h, product), h.after),
  ]
  const result: ApplyResult = {
    hypothesisId: h.id,
    type: h.type,
    productId: product.id,
    changes,
    response: { dryRun: true },
    appliedAt: new Date().toISOString(),
  }
  if (h.type === 'variant_title' && h.variantId) {
    result.variantId = h.variantId
  }
  if ((h.type === 'metafield_add' || h.type === 'metafield_update') && h.metafieldNamespace) {
    result.metafieldNamespace = h.metafieldNamespace
    result.metafieldKey = h.metafieldKey
    result.metafieldType = h.metafieldType
  }
  return result
}

function fieldLabel(h: Hypothesis): string {
  switch (h.type) {
    case 'title_rewrite':
      return 'title'
    case 'description_restructure':
      return 'descriptionHtml'
    case 'seo_title':
      return 'seo.title'
    case 'seo_description':
      return 'seo.description'
    case 'tags_update':
      return 'tags'
    case 'variant_title':
      return `variants.${h.variantId}.title`
    case 'metafield_add':
    case 'metafield_update':
      return `metafields.${h.metafieldNamespace}.${h.metafieldKey}`
  }
}

function currentValue(h: Hypothesis, p: ShopifyProduct): string {
  switch (h.type) {
    case 'title_rewrite':
      return p.title
    case 'description_restructure':
      return p.descriptionHtml
    case 'seo_title':
      return p.seo.title ?? ''
    case 'seo_description':
      return p.seo.description ?? ''
    case 'tags_update':
      return p.tags.join(', ')
    case 'variant_title':
      return p.variants.find((v) => v.id === h.variantId)?.title ?? ''
    case 'metafield_add':
    case 'metafield_update':
      return (
        p.metafields.find(
          (m) => m.namespace === h.metafieldNamespace && m.key === h.metafieldKey,
        )?.value ?? ''
      )
  }
}

function truncateValue(s: string): string {
  return s.length <= 80 ? s : `${s.slice(0, 79)}…`
}
