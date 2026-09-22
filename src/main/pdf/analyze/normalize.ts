const LIGATURES: Record<string, string> = {
  ﬁ: 'fi',
  ﬂ: 'fl',
  ﬀ: 'ff',
  ﬃ: 'ffi',
  ﬄ: 'ffl',
}

export function joinLineTexts(prev: string, next: string): string {
  if (prev.endsWith('-') && /^[a-z]/.test(next)) return prev.slice(0, -1) + next
  if (prev.endsWith('-') && /^[A-Z]/.test(next)) return `${prev}${next}`
  if (!prev) return next
  if (!next) return prev
  return `${prev} ${next}`
}

export function normalizeParagraphText(text: string): string {
  let out = text
  for (const [from, to] of Object.entries(LIGATURES)) out = out.split(from).join(to)
  out = out.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '')
  out = out.replace(/\s+/g, ' ').trim()
  out = out.replace(/\s*(\{v\d+\})\s*/g, ' $1 ').trim()
  return out.replace(/\s+/g, ' ').trim()
}
