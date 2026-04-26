/**
 * Generate a realistic shelf.jsonl + shelf.md that exercises every section
 * of `npx shelf-ai eval`:
 *
 *   1. Hypothesis effectiveness — all 7 hypothesis types with distinct
 *      keep/revert profiles so the EV ranking is interesting.
 *   2. Plateau detection — 35 measurement iterations curve up steeply
 *      through iter ~16, slow through iter ~25, then flatten so the
 *      detector fires around iter 26.
 *   3. Reward-hacking audit — kept title rewrites get progressively
 *      longer; kept descriptions drift to higher reading grades; keyword
 *      density and product diversity stay clean. Verdict: "medium" risk.
 *   4. Provider disagreement — current log shape doesn't carry per-provider
 *      data, so the eval reports "available: false". Nothing to fake.
 *   5. Score stability — `--live` only, skipped here.
 *
 * Plus 3 checks_failed and 1 generator_failed entries scattered through.
 *
 *   pnpm tsx scripts/generate-demo-log.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nanoid } from 'nanoid'
import type { ExperimentLog, Verdict } from '@shelf/core'
import type {
  ApplyResult,
  FieldChange,
  Hypothesis,
  HypothesisType,
} from '../packages/core/src/hypothesis/types.js'

const OUT_DIR = resolve(process.cwd(), 'demo')
const JSONL_PATH = resolve(OUT_DIR, 'shelf.jsonl')
const MD_PATH = resolve(OUT_DIR, 'shelf.md')

const PRODUCTS = [
  { gid: 'gid://shopify/Product/8234567890', title: 'Explorer Pro Jacket' },
  { gid: 'gid://shopify/Product/8234567891', title: 'Summit Trail Boots' },
  { gid: 'gid://shopify/Product/8234567892', title: 'Alpine Down Vest' },
  { gid: 'gid://shopify/Product/8234567893', title: 'Ridgeline Backpack 45L' },
  { gid: 'gid://shopify/Product/8234567894', title: 'Glacier Camp Stove' },
  { gid: 'gid://shopify/Product/8234567895', title: 'Cascade Trail Runners' },
  { gid: 'gid://shopify/Product/8234567896', title: 'Storm Shell Pants' },
  { gid: 'gid://shopify/Product/8234567897', title: 'Mesa Sun Hoodie' },
  { gid: 'gid://shopify/Product/8234567898', title: 'Talus Sleeping Bag' },
  { gid: 'gid://shopify/Product/8234567899', title: 'Vista Trekking Poles' },
] as const

// Title rewrites in the order they're "kept" — designed so length creeps
// up monotonically (~9 chars/iter), tripping the title-inflation signal.
const TITLE_REWRITES_KEPT = [
  'Explorer Pro Jacket — Waterproof Hiking Shell',
  'Summit Trail Boots — Waterproof Lightweight Hiking Footwear',
  'Alpine Down Vest — Insulated Lightweight Outerwear for Cold Weather',
  'Ridgeline Backpack 45L — Waterproof Multi-Day Trekking and Camping Pack',
  'Glacier Camp Stove — Compact Lightweight Backpacking Cooking System for Outdoor Adventures',
]

// Description rewrites in the order they're "kept" — sentence length and
// syllables-per-word climb so Flesch-Kincaid grade rises ~6 → ~9.
const DESC_REWRITES_KEPT = [
  '<p>Lightweight rain shell. Built for fast hikes. Packs to fist size. Waterproof and breathable. Trail-ready in any weather.</p>',
  '<p>Engineered for serious backcountry travel, this multi-day pack distributes weight evenly across hip and shoulder. Ventilated suspension keeps your back cool through long approaches and humid mornings on the trail.</p>',
  '<p>Designed for serious backcountry weather, this technical shell pairs a three-layer waterproof membrane with reinforced shoulder panels. The panels survive heavy pack straps over multi-day alpine approaches and resist abrasion from rope work.</p>',
]

const SEO_TITLE_REWRITES = [
  'Waterproof Hiking Jacket | Explorer Pro',
  'Lightweight Trail Running Shoes | Cascade',
  'Best Backpacking Stove 2026 | Glacier',
]

const SEO_DESC_REWRITE = '3-layer waterproof shell with sealed seams and pit zips. 10,000mm hydrostatic head, 20,000g/m²/24h breathability. Ideal for rainy day-hikes and shoulder-season backpacking.'

const TAG_LISTS = ['waterproof, 3-layer, pit-zips, breathable']

const METAFIELD_ADDS = [
  { ns: 'custom', key: 'waterproof_rating_mm', value: '10000', kept: true, delta: 7 },
  { ns: 'custom', key: 'fill_power', value: '850', kept: true, delta: 6 },
]

const METAFIELD_UPDATE = { ns: 'custom', key: 'weight_grams', oldValue: '650', newValue: '590' }

let titleRewriteKeptIdx = 0
let descRewriteKeptIdx = 0
let seoTitleIdx = 0
let metafieldAddIdx = 0

interface Plan {
  iter: number
  kind: 'measure' | 'checks_failed' | 'generator_failed'
  type?: HypothesisType
  // For 'checks_failed' / 'generator_failed', `failureType` records which
  // hypothesis kind tripped the failure so per-type stats reflect reality.
  failureType?: HypothesisType
  verdict?: Verdict
  delta?: number  // scoreDelta; scoreAfter is computed
  productIdx: number
}

// 35 measurements + 3 checks_failed + 1 generator_failed.
//
// Per-type kept/reverted counts (matching spec):
//   title_rewrite: 5k 3r       (avg kept +5, "+4-6")
//   description_restructure: 3k 3r  (avg kept +4, "+3-5")
//   metafield_add: 2k 3r       (avg kept +6.5, "+6-8" — high impact)
//   seo_title: 3k 2r           (avg kept +2.3, "+2-3")
//   seo_description: 1k 3r     (avg kept +2, "+1-2")
//   tags_update: 1k 3r         (avg kept +1)
//   metafield_update: 1k 2r    (avg kept +3)
//
// Trajectory: climb 25→73 by iter 16, slow → 79 by iter 25, plateau
// drifts to ~76 through iter 39. The first 5-window of consecutive
// measurements with positive delta < 1.0 starts at iter 26 — the
// detector reports plateauIteration = 26.
const PLAN: Plan[] = [
  { iter: 1,  kind: 'measure', type: 'title_rewrite',           verdict: 'kept',     delta: +4,    productIdx: 0 },
  { iter: 2,  kind: 'measure', type: 'seo_title',               verdict: 'kept',     delta: +2,    productIdx: 1 },
  { iter: 3,  kind: 'measure', type: 'metafield_add',           verdict: 'reverted', delta: -2,    productIdx: 2 },
  { iter: 4,  kind: 'measure', type: 'title_rewrite',           verdict: 'kept',     delta: +5,    productIdx: 3 },
  { iter: 5,  kind: 'measure', type: 'description_restructure', verdict: 'kept',     delta: +3,    productIdx: 4 },
  { iter: 6,  kind: 'measure', type: 'seo_description',         verdict: 'reverted', delta: -1,    productIdx: 5 },
  { iter: 7,  kind: 'measure', type: 'metafield_add',           verdict: 'kept',     delta: +7,    productIdx: 6 },
  { iter: 8,  kind: 'measure', type: 'title_rewrite',           verdict: 'kept',     delta: +5,    productIdx: 7 },
  { iter: 9,  kind: 'checks_failed',         failureType: 'title_rewrite',                            productIdx: 8 },
  { iter: 10, kind: 'measure', type: 'description_restructure', verdict: 'kept',     delta: +4,    productIdx: 9 },
  { iter: 11, kind: 'measure', type: 'tags_update',             verdict: 'reverted', delta: -1,    productIdx: 0 },
  { iter: 12, kind: 'measure', type: 'seo_title',               verdict: 'kept',     delta: +3,    productIdx: 1 },
  { iter: 13, kind: 'measure', type: 'title_rewrite',           verdict: 'kept',     delta: +6,    productIdx: 2 },
  { iter: 14, kind: 'measure', type: 'metafield_add',           verdict: 'kept',     delta: +6,    productIdx: 3 },
  { iter: 15, kind: 'measure', type: 'seo_description',         verdict: 'kept',     delta: +2,    productIdx: 4 },
  { iter: 16, kind: 'measure', type: 'description_restructure', verdict: 'kept',     delta: +5,    productIdx: 5 },
  { iter: 17, kind: 'measure', type: 'metafield_update',        verdict: 'reverted', delta: -1,    productIdx: 6 },
  { iter: 18, kind: 'generator_failed',      failureType: 'description_restructure',                 productIdx: 7 },
  { iter: 19, kind: 'measure', type: 'title_rewrite',           verdict: 'reverted', delta: -1,    productIdx: 8 },
  { iter: 20, kind: 'measure', type: 'seo_title',               verdict: 'kept',     delta: +2,    productIdx: 9 },
  { iter: 21, kind: 'measure', type: 'title_rewrite',           verdict: 'reverted', delta: -1,    productIdx: 0 },
  { iter: 22, kind: 'measure', type: 'metafield_update',        verdict: 'kept',     delta: +3,    productIdx: 1 },
  { iter: 23, kind: 'measure', type: 'description_restructure', verdict: 'reverted', delta: -1,    productIdx: 2 },
  { iter: 24, kind: 'measure', type: 'seo_title',               verdict: 'reverted', delta: -1,    productIdx: 3 },
  { iter: 25, kind: 'measure', type: 'tags_update',             verdict: 'kept',     delta: +1,    productIdx: 4 },
  { iter: 26, kind: 'measure', type: 'title_rewrite',           verdict: 'kept',     delta: +4,    productIdx: 8 },
  { iter: 27, kind: 'measure', type: 'description_restructure', verdict: 'reverted', delta:  0,    productIdx: 6 },
  { iter: 28, kind: 'checks_failed',         failureType: 'title_rewrite',                           productIdx: 7 },
  { iter: 29, kind: 'measure', type: 'metafield_add',           verdict: 'reverted', delta: -1,    productIdx: 8 },
  { iter: 30, kind: 'measure', type: 'seo_description',         verdict: 'reverted', delta:  0,    productIdx: 9 },
  { iter: 31, kind: 'measure', type: 'title_rewrite',           verdict: 'reverted', delta:  0,    productIdx: 0 },
  { iter: 32, kind: 'measure', type: 'metafield_update',        verdict: 'reverted', delta:  0,    productIdx: 1 },
  { iter: 33, kind: 'measure', type: 'description_restructure', verdict: 'reverted', delta:  0,    productIdx: 2 },
  { iter: 34, kind: 'measure', type: 'tags_update',             verdict: 'reverted', delta:  0,    productIdx: 3 },
  { iter: 35, kind: 'measure', type: 'metafield_add',           verdict: 'reverted', delta: -1,    productIdx: 4 },
  { iter: 36, kind: 'checks_failed',         failureType: 'seo_title',                               productIdx: 5 },
  { iter: 37, kind: 'measure', type: 'seo_description',         verdict: 'reverted', delta:  0,    productIdx: 6 },
  { iter: 38, kind: 'measure', type: 'tags_update',             verdict: 'reverted', delta:  0,    productIdx: 7 },
  { iter: 39, kind: 'measure', type: 'seo_title',               verdict: 'reverted', delta:  0,    productIdx: 8 },
]

// Deterministic-ish noise for cost estimates so the demo is reproducible
// across runs but doesn't look mechanical.
function pseudoCost(iter: number): number {
  const x = Math.sin(iter * 12.9898) * 43758.5453
  const frac = x - Math.floor(x)
  return Number((0.04 + frac * 0.08).toFixed(4))
}

const START_TIME = Date.parse('2026-04-22T11:42:20Z')
const ITER_GAP_MS = 28_000  // ~28s per iteration, realistic spacing

function timestampFor(iter: number, offsetMs = 0): string {
  return new Date(START_TIME + iter * ITER_GAP_MS + offsetMs).toISOString()
}

function buildHypothesis(
  type: HypothesisType,
  productIdx: number,
  before: string,
  after: string,
): Hypothesis {
  const product = PRODUCTS[productIdx]
  const field =
    type === 'tags_update'                       ? 'tags' :
    type === 'metafield_add'                     ? 'metafield' :
    type === 'metafield_update'                  ? 'metafield' :
    type === 'description_restructure'           ? 'descriptionHtml' :
    type === 'seo_description'                   ? 'seo.description' :
    type === 'seo_title'                         ? 'seo.title' :
                                                   'title'
  return {
    id: nanoid(),
    type,
    productId: product.gid,
    productTitle: product.title,
    field,
    before,
    after,
    description: `Demo: ${type} on ${product.title}`,
    reasoning: 'Demo hypothesis generated by scripts/generate-demo-log.ts',
    queryFailurePatterns: ['waterproof', 'category', 'specs'],
    predictedEffect: 'more matches on category + attribute queries',
    riskLevel: 'low',
    confidence: 'medium',
    estimatedImpact: '+3',
    promptVersion: 'hypothesis.v1',
    ...(type === 'metafield_add' || type === 'metafield_update'
      ? { metafieldNamespace: 'custom', metafieldKey: 'demo_field', metafieldType: 'single_line_text_field' }
      : {}),
  }
}

// Synthesize a hypothesis + the realistic checks that would reject it,
// so the failure is attributed to the hypothesis kind that actually
// produced it instead of all stacking on title_rewrite.
function buildFailedHypothesis(
  type: HypothesisType,
  productIdx: number,
): { hyp: Hypothesis; failures: string[] } {
  const product = PRODUCTS[productIdx]
  switch (type) {
    case 'title_rewrite':
      return {
        hyp: buildHypothesis(type, productIdx, product.title, `${product.title} — BUY NOW BEST DEAL`),
        failures: ['title_starts_with_buy_shop_or_best', 'all_caps_word_too_long'],
      }
    case 'metafield_add':
      return {
        hyp: buildHypothesis(type, productIdx, '', '15000'),
        failures: ['metafield_value_not_grounded_in_product_data'],
      }
    case 'seo_title':
      return {
        hyp: buildHypothesis(type, productIdx, `${product.title} | Northwest Outfitters`, `${product.title} — Best Waterproof Hiking Jacket Premium Quality 2026`),
        failures: ['seo_title_keyword_repeated_too_many_times'],
      }
    default:
      return {
        hyp: buildHypothesis(type, productIdx, '', ''),
        failures: ['backpressure_check_failed'],
      }
  }
}

function buildChange(plan: Plan): { before: string; after: string; change: FieldChange } | null {
  if (!plan.type) return null
  const product = PRODUCTS[plan.productIdx]

  switch (plan.type) {
    case 'title_rewrite': {
      // Use the curated kept rewrite for the next slot if this is a kept
      // experiment; otherwise just append a milder suffix so reverted
      // titles don't pollute the title-length series.
      const isKept = plan.verdict === 'kept' || plan.verdict === 'kept_uncertain'
      const after = isKept
        ? TITLE_REWRITES_KEPT[titleRewriteKeptIdx++]
        : `${product.title} — Lightweight Outdoor Gear`
      return {
        before: product.title,
        after,
        change: { field: 'title', oldValue: product.title, newValue: after },
      }
    }
    case 'description_restructure': {
      const isKept = plan.verdict === 'kept' || plan.verdict === 'kept_uncertain'
      const after = isKept
        ? DESC_REWRITES_KEPT[descRewriteKeptIdx++]
        : '<p>Built for the trail. Tested in the rain.</p>'
      const before = '<p>Outdoor gear for everyday adventures.</p>'
      return {
        before,
        after,
        change: { field: 'descriptionHtml', oldValue: before, newValue: after },
      }
    }
    case 'metafield_add': {
      const spec = METAFIELD_ADDS[Math.min(metafieldAddIdx++, METAFIELD_ADDS.length - 1)]
      const before = ''
      const after = spec.value
      return {
        before,
        after,
        change: { field: `metafield:${spec.ns}.${spec.key}`, oldValue: before, newValue: after },
      }
    }
    case 'metafield_update': {
      return {
        before: METAFIELD_UPDATE.oldValue,
        after: METAFIELD_UPDATE.newValue,
        change: {
          field: `metafield:${METAFIELD_UPDATE.ns}.${METAFIELD_UPDATE.key}`,
          oldValue: METAFIELD_UPDATE.oldValue,
          newValue: METAFIELD_UPDATE.newValue,
        },
      }
    }
    case 'seo_title': {
      const after = SEO_TITLE_REWRITES[Math.min(seoTitleIdx++, SEO_TITLE_REWRITES.length - 1)]
      const before = `${product.title} | Northwest Outfitters`
      return {
        before,
        after,
        change: { field: 'seo.title', oldValue: before, newValue: after },
      }
    }
    case 'seo_description': {
      const before = 'Quality outdoor gear for every adventure.'
      return {
        before,
        after: SEO_DESC_REWRITE,
        change: { field: 'seo.description', oldValue: before, newValue: SEO_DESC_REWRITE },
      }
    }
    case 'tags_update': {
      const before = 'outdoor, hiking'
      return {
        before,
        after: TAG_LISTS[0],
        change: { field: 'tags', oldValue: before, newValue: TAG_LISTS[0] },
      }
    }
  }
  return null
}

function buildLog(plan: Plan, scoreBefore: number): { entry: ExperimentLog; scoreAfter: number } {
  const product = PRODUCTS[plan.productIdx]

  if (plan.kind === 'checks_failed') {
    const failureType = plan.failureType ?? 'title_rewrite'
    const { hyp, failures } = buildFailedHypothesis(failureType, plan.productIdx)
    const entry: ExperimentLog = {
      id: nanoid(),
      iteration: plan.iter,
      timestamp: timestampFor(plan.iter),
      hypothesis: hyp,
      verdict: 'checks_failed',
      scoreBefore,
      scoreAfter: scoreBefore,
      scoreDelta: 0,
      confidence: 0,
      confidenceLevel: 'noise',
      durationMs: 410,
      costEstimateUsd: 0.012,
      failures,
    }
    return { entry, scoreAfter: scoreBefore }
  }

  if (plan.kind === 'generator_failed') {
    const failureType = plan.failureType ?? 'description_restructure'
    const hyp = buildHypothesis(failureType, plan.productIdx, '', '')
    const entry: ExperimentLog = {
      id: nanoid(),
      iteration: plan.iter,
      timestamp: timestampFor(plan.iter),
      hypothesis: hyp,
      verdict: 'generator_failed',
      scoreBefore,
      scoreAfter: scoreBefore,
      scoreDelta: 0,
      confidence: 0,
      confidenceLevel: 'noise',
      durationMs: 1_240,
      costEstimateUsd: 0.018,
      error: 'Anthropic returned malformed JSON for hypothesis proposal (retry budget exhausted).',
    }
    return { entry, scoreAfter: scoreBefore }
  }

  // Measurement.
  const change = buildChange(plan)!
  const hyp = buildHypothesis(plan.type!, plan.productIdx, change.before, change.after)
  const delta = plan.delta ?? 0
  const scoreAfter = Number((scoreBefore + delta).toFixed(2))
  const verdict: Verdict = plan.verdict!

  // For kept verdicts, attach an applyResult so the reward-hacking audit
  // can inspect the title/description new values. For reverted, also
  // attach applyResult (the change was applied, then rolled back) plus
  // a revertResult shaped appropriately.
  const apply: ApplyResult = {
    hypothesisId: hyp.id,
    type: hyp.type,
    productId: hyp.productId,
    changes: [change.change],
    response: { dryRun: false, demo: true },
    appliedAt: timestampFor(plan.iter, -2_000),
    ...(hyp.type === 'metafield_add' || hyp.type === 'metafield_update'
      ? {
          metafieldNamespace: hyp.metafieldNamespace,
          metafieldKey: hyp.metafieldKey,
          metafieldType: hyp.metafieldType,
        }
      : {}),
  }

  const entry: ExperimentLog = {
    id: nanoid(),
    iteration: plan.iter,
    timestamp: timestampFor(plan.iter),
    hypothesis: hyp,
    verdict,
    scoreBefore,
    scoreAfter,
    scoreDelta: delta,
    confidence: Math.abs(delta),
    confidenceLevel: Math.abs(delta) >= 3 ? 'medium' : Math.abs(delta) >= 1.5 ? 'low' : 'noise',
    durationMs: 18_000 + Math.round(Math.abs(Math.sin(plan.iter)) * 4_000),
    costEstimateUsd: pseudoCost(plan.iter),
    applyResult: apply,
    ...(verdict === 'reverted'
      ? {
          revertResult: {
            hypothesisId: hyp.id,
            productId: hyp.productId,
            restoredChanges: [{
              field: change.change.field,
              oldValue: change.change.newValue,
              newValue: change.change.oldValue,
            }],
            response: { dryRun: false, demo: true },
            revertedAt: timestampFor(plan.iter, 1_500),
          },
        }
      : {}),
  }

  return { entry, scoreAfter }
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true })

  let score = 25
  const lines: string[] = []
  for (const plan of PLAN) {
    const { entry, scoreAfter } = buildLog(plan, score)
    lines.push(JSON.stringify(entry))
    score = scoreAfter
  }
  writeFileSync(JSONL_PATH, lines.join('\n') + '\n', 'utf-8')

  const md = `# shelf session — demo

## Objective
Exercise every section of \`shelf eval\` against a hand-authored 35-experiment trace.
Catalog is a fictional outdoor-gear store with 10 products; baseline AI Shelf Score 25.

## What's been tried
- 8 \`title_rewrite\` experiments (5 kept) — leading category keywords + attribute stacking.
- 6 \`description_restructure\` (3 kept) — replaced marketing copy with specs + use cases.
- 5 \`metafield_add\` (2 kept) — high-impact spec metafields like \`waterproof_rating_mm\`.
- 5 \`seo_title\` (3 kept) — query-intent-led \`<title>\` rewrites.
- 4 \`seo_description\` (1 kept) — meta-description tightening.
- 4 \`tags_update\` (1 kept) — most reverted as low-signal.
- 3 \`metafield_update\` (1 kept) — corrections to existing values.
- 4 failures (3 \`checks_failed\`, 1 \`generator_failed\`).

## Dead ends
- \`tags_update\` and \`seo_description\` consistently produced near-zero or
  negative deltas — the providers don't seem to weight them strongly.
- After iter ~26 the loop stopped finding improvements; deltas hover at 0
  and reverts dominate.

## Key wins
- Iter 7: \`metafield_add\` of \`waterproof_rating_mm = "10000"\` lifted score by +7.
- Iter 13: \`title_rewrite\` of Alpine Down Vest gained +6.
- Iter 16: \`description_restructure\` of Cascade Trail Runners gained +5.

Final score: ${score.toFixed(1)} / 100.
`
  writeFileSync(MD_PATH, md, 'utf-8')

  // eslint-disable-next-line no-console
  console.log(`✓ wrote ${lines.length} entries → ${JSONL_PATH}`)
  // eslint-disable-next-line no-console
  console.log(`✓ wrote session doc → ${MD_PATH}`)
  // eslint-disable-next-line no-console
  console.log('')
  // eslint-disable-next-line no-console
  console.log('Run the eval against this trace:')
  // eslint-disable-next-line no-console
  console.log('')
  // eslint-disable-next-line no-console
  console.log('  cp demo/shelf.jsonl ./shelf.jsonl && npx shelf-ai eval')
  // eslint-disable-next-line no-console
  console.log('')
  // eslint-disable-next-line no-console
  console.log('  # or, without copying:')
  // eslint-disable-next-line no-console
  console.log('  SHELF_LOG_FILE=demo/shelf.jsonl npx shelf-ai eval')
  // eslint-disable-next-line no-console
  console.log('')
}

main()
