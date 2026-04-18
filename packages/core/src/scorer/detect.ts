export interface DomainDetection {
  appeared: boolean
  position?: number
  snippet?: string
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
}

function rootDomain(domain: string): string {
  const d = normalizeDomain(domain)
  const parts = d.split('.')
  if (parts.length >= 3 && parts[0] === 'www') {
    return parts.slice(1).join('.')
  }
  return d
}

// Matches either a citation URL that references the store domain, or a textual mention.
// URL matches win because they are the signal an AI agent would actually cite.
export function detectDomainAppearance(
  storeDomain: string,
  text: string,
  urls: string[],
): DomainDetection {
  const target = rootDomain(storeDomain)
  if (!target) return { appeared: false }

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    if (typeof url !== 'string') continue
    if (url.toLowerCase().includes(target)) {
      return { appeared: true, position: i + 1, snippet: url }
    }
  }

  const lowerText = text.toLowerCase()
  const idx = lowerText.indexOf(target)
  if (idx >= 0) {
    const start = Math.max(0, idx - 80)
    const end = Math.min(text.length, idx + target.length + 80)
    return { appeared: true, snippet: text.slice(start, end).trim() }
  }

  return { appeared: false }
}
