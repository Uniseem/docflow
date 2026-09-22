const PROTECT_RE = /(?:DOCFLOWKEEP\d{6}TOKEN|\{\s*v\s*\d+\s*\}|<\/?segment\b[^>]*>)/gi

export function tokenName(index: number): string {
  return `DOCFLOWKEEP${String(index).padStart(6, '0')}TOKEN`
}

export type Protection = {
  texts: string[]
  tokens: string[]
  originals: Map<string, string>
}

export function protectTexts(texts: string[]): Protection {
  let index = 0
  const originals = new Map<string, string>()
  const tokens: string[] = []
  const protectedTexts = texts.map((text) => {
    PROTECT_RE.lastIndex = 0
    return text.replace(PROTECT_RE, (matched) => {
      const token = tokenName(index)
      index += 1
      originals.set(token, matched)
      tokens.push(token)
      return token
    })
  })
  return { texts: protectedTexts, tokens, originals }
}

export function restoreTokens(text: string, originals: Map<string, string>): string {
  let out = text
  for (const [token, original] of originals) {
    out = out.split(token).join(original)
  }
  return out
}
