import type { ShopifyAdminClient } from '../shopify/admin.js'
import type { ApplyResult, FieldChange, RevertResult } from './types.js'

export class HypothesisRevertError extends Error {
  readonly hypothesisId: string
  constructor(message: string, hypothesisId: string) {
    super(message)
    this.name = 'HypothesisRevertError'
    this.hypothesisId = hypothesisId
  }
}

export interface HypothesisReverterOptions {
  dryRun?: boolean
}

export class HypothesisReverter {
  private admin: ShopifyAdminClient
  private dryRun: boolean

  constructor(admin: ShopifyAdminClient, options: HypothesisReverterOptions = {}) {
    this.admin = admin
    this.dryRun = options.dryRun ?? false
  }

  async revert(applied: ApplyResult): Promise<RevertResult> {
    if (this.dryRun) return revertDryRun(applied)
    switch (applied.type) {
      case 'title_rewrite':
        return this.revertTitle(applied)
      case 'description_restructure':
        return this.revertDescription(applied)
      case 'seo_title':
        return this.revertSeoTitle(applied)
      case 'seo_description':
        return this.revertSeoDescription(applied)
      case 'tags_update':
        return this.revertTags(applied)
      case 'metafield_add':
        return this.revertMetafieldAdd(applied)
      case 'metafield_update':
        return this.revertMetafieldUpdate(applied)
      case 'variant_title':
        return this.revertVariantTitle(applied)
    }
  }

  private async revertTitle(r: ApplyResult): Promise<RevertResult> {
    const ch = firstChange(r)
    const response = await this.admin.updateProduct({ id: r.productId, title: ch.oldValue })
    return buildRevert(r, [reverse(ch)], response)
  }

  private async revertDescription(r: ApplyResult): Promise<RevertResult> {
    const ch = firstChange(r)
    const response = await this.admin.updateProduct({
      id: r.productId,
      descriptionHtml: ch.oldValue,
    })
    return buildRevert(r, [reverse(ch)], response)
  }

  private async revertSeoTitle(r: ApplyResult): Promise<RevertResult> {
    const ch = firstChange(r)
    const response = await this.admin.updateProduct({
      id: r.productId,
      seo: { title: ch.oldValue },
    })
    return buildRevert(r, [reverse(ch)], response)
  }

  private async revertSeoDescription(r: ApplyResult): Promise<RevertResult> {
    const ch = firstChange(r)
    const response = await this.admin.updateProduct({
      id: r.productId,
      seo: { description: ch.oldValue },
    })
    return buildRevert(r, [reverse(ch)], response)
  }

  private async revertTags(r: ApplyResult): Promise<RevertResult> {
    const ch = firstChange(r)
    const oldTags = ch.oldValue
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const response = await this.admin.updateProduct({ id: r.productId, tags: oldTags })
    return buildRevert(r, [reverse(ch)], response)
  }

  private async revertMetafieldAdd(r: ApplyResult): Promise<RevertResult> {
    if (!r.metafieldNamespace || !r.metafieldKey) {
      throw new HypothesisRevertError(
        'metafield_add revert missing namespace/key',
        r.hypothesisId,
      )
    }
    const ch = firstChange(r)
    const response = await this.admin.deleteMetafields([
      { ownerId: r.productId, namespace: r.metafieldNamespace, key: r.metafieldKey },
    ])
    return buildRevert(r, [reverse(ch)], response)
  }

  private async revertMetafieldUpdate(r: ApplyResult): Promise<RevertResult> {
    if (!r.metafieldNamespace || !r.metafieldKey || !r.metafieldType) {
      throw new HypothesisRevertError(
        'metafield_update revert missing namespace/key/type',
        r.hypothesisId,
      )
    }
    const ch = firstChange(r)
    const response = await this.admin.setMetafields([
      {
        ownerId: r.productId,
        namespace: r.metafieldNamespace,
        key: r.metafieldKey,
        type: r.metafieldType,
        value: ch.oldValue,
      },
    ])
    return buildRevert(r, [reverse(ch)], response)
  }

  private async revertVariantTitle(r: ApplyResult): Promise<RevertResult> {
    if (!r.variantId) {
      throw new HypothesisRevertError(
        'variant_title revert missing variantId',
        r.hypothesisId,
      )
    }
    const ch = firstChange(r)
    const response = await this.admin.updateVariants(r.productId, [
      { id: r.variantId, title: ch.oldValue },
    ])
    return buildRevert(r, [reverse(ch)], response)
  }
}

function firstChange(r: ApplyResult): FieldChange {
  const ch = r.changes[0]
  if (!ch) {
    throw new HypothesisRevertError('ApplyResult has no changes to revert', r.hypothesisId)
  }
  return ch
}

function reverse(c: FieldChange): FieldChange {
  return { field: c.field, oldValue: c.newValue, newValue: c.oldValue }
}

function buildRevert(
  r: ApplyResult,
  restoredChanges: FieldChange[],
  response: unknown,
): RevertResult {
  return {
    hypothesisId: r.hypothesisId,
    productId: r.productId,
    restoredChanges,
    response,
    revertedAt: new Date().toISOString(),
  }
}

function revertDryRun(applied: ApplyResult): RevertResult {
  const field = applied.changes[0]?.field ?? applied.type
  console.log(`[dry-run] would revert ${applied.type} on ${applied.productId} (${field})`)
  return buildRevert(applied, applied.changes.map(reverse), { dryRun: true })
}
