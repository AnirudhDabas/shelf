import type { Hypothesis } from '../hypothesis/types.js'
import type { ShopifyProduct } from '../shopify/types.js'

export interface BackpressureResult {
  passed: boolean
  failures: string[]
  warnings: string[]
}

// Minimal English stopword set used only for keyword-density checks.
// Keeping this local avoids a dependency on an NLP package.
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'your',
  'our',
  'you',
  'we',
  'they',
  'them',
  'us',
  'so',
  'not',
  'no',
  'can',
  'will',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'up',
  'down',
  'out',
  'over',
  'more',
  'most',
  'some',
  'any',
])

const SPAMMY_TITLE_PREFIX = /^\s*(buy|shop|best)\b/i
const TITLE_MIN = 10
const TITLE_MAX = 255
const TITLE_WARN = 100
const DESC_MIN = 50
const DESC_MAX = 5000
const GRADE_MIN = 5
const GRADE_MAX = 12
const DENSITY_MAX = 3

export function checkHypothesis(
  hypothesis: Hypothesis,
  product: ShopifyProduct,
): BackpressureResult {
  const failures: string[] = []
  const warnings: string[] = []

  const { title, description } = projectCorpus(hypothesis, product)
  const descText = stripHtml(description)

  if (hypothesis.type === 'title_rewrite') {
    if (title.length < TITLE_MIN) {
      failures.push(`title too short: ${title.length} chars (min ${TITLE_MIN})`)
    } else if (title.length > TITLE_MAX) {
      failures.push(`title too long: ${title.length} chars (max ${TITLE_MAX})`)
    } else if (title.length > TITLE_WARN) {
      warnings.push(`title is long: ${title.length} chars`)
    }
  }

  if (descText.length < DESC_MIN) {
    failures.push(`description too short: ${descText.length} chars (min ${DESC_MIN})`)
  } else if (descText.length > DESC_MAX) {
    failures.push(`description too long: ${descText.length} chars (max ${DESC_MAX})`)
  }

  const densityViolation = findKeywordDensityViolation(`${title} ${descText}`)
  if (densityViolation) {
    failures.push(
      `keyword "${densityViolation.word}" appears ${densityViolation.count}x in title+description (max ${DENSITY_MAX})`,
    )
  }

  if (descText.length > 0) {
    const grade = fleschKincaidGrade(descText)
    if (grade < GRADE_MIN) {
      failures.push(`reading grade ${grade.toFixed(1)} below ${GRADE_MIN}`)
    } else if (grade > GRADE_MAX) {
      failures.push(`reading grade ${grade.toFixed(1)} above ${GRADE_MAX}`)
    }
  }

  for (const word of findAllCapsWords(title)) {
    failures.push(`ALL CAPS word "${word}" in title (acronyms up to 4 chars allowed)`)
  }

  if (SPAMMY_TITLE_PREFIX.test(title)) {
    failures.push('title starts with a spammy word (buy/shop/best)')
  }

  if (hypothesis.type === 'metafield_add' || hypothesis.type === 'metafield_update') {
    if (!isValueGrounded(hypothesis.after, product)) {
      failures.push(
        `metafield value "${truncate(hypothesis.after, 60)}" is not present in or inferable from original product data`,
      )
    }
  }

  return { passed: failures.length === 0, failures, warnings }
}

function projectCorpus(
  h: Hypothesis,
  p: ShopifyProduct,
): { title: string; description: string } {
  const title = h.type === 'title_rewrite' ? h.after : p.title
  const description = h.type === 'description_restructure' ? h.after : p.descriptionHtml
  return { title, description }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findKeywordDensityViolation(text: string): { word: string; count: number } | null {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const counts = new Map<string, number>()
  for (const w of words) {
    if (w.length < 3) continue
    if (STOP_WORDS.has(w)) continue
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  for (const [word, count] of counts) {
    if (count > DENSITY_MAX) return { word, count }
  }
  return null
}

function findAllCapsWords(text: string): string[] {
  const tokens = text.match(/[A-Z0-9-]{2,}/g) ?? []
  const violations: string[] = []
  for (const token of tokens) {
    const letters = token.replace(/[^A-Z]/g, '')
    if (letters.length > 4) violations.push(token)
  }
  return violations
}

function fleschKincaidGrade(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?]+/g) ?? []).length)
  const words = text.match(/[A-Za-z]+/g) ?? []
  if (words.length === 0) return 0
  let syllables = 0
  for (const w of words) syllables += syllableCount(w)
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59
}

function syllableCount(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.length === 0) return 0
  if (w.length <= 3) return 1
  let trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
  trimmed = trimmed.replace(/^y/, '')
  const groups = trimmed.match(/[aeiouy]+/g)
  return Math.max(1, groups?.length ?? 0)
}

// A proposed metafield value is "grounded" when at least one substantive token
// from the value appears in the original product data. This blocks the
// optimizer from inventing attributes (e.g. fabricating "GORE-TEX" when the
// source says nothing about waterproof membranes) without forcing the value
// to be a verbatim substring.
function isValueGrounded(value: string, product: ShopifyProduct): boolean {
  const tokens = (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 4 && !STOP_WORDS.has(t),
  )
  if (tokens.length === 0) return true

  const haystack = stripHtml(
    [
      product.title,
      product.descriptionHtml,
      product.productType ?? '',
      product.vendor ?? '',
      product.tags.join(' '),
      product.seo.title ?? '',
      product.seo.description ?? '',
      ...product.metafields.map((m) => `${m.key} ${m.value}`),
    ].join(' '),
  ).toLowerCase()

  return tokens.some((t) => haystack.includes(t))
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
