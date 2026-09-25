// BabelDOC TranslationConfig.parse_pages / should_translate_page: "1-3,5,8-", "-3".

export type PageRange = [start: number, end: number]

/** Python int() of a range part: optional sign and surrounding whitespace, decimal digits. */
function pyInt(text: string): number {
  if (!/^\s*[-+]?\d+\s*$/.test(text)) throw new Error(`invalid page number ${JSON.stringify(text)}`)
  return Number.parseInt(text, 10)
}

/** parse_pages: 1-based (start, end) ranges, end -1 for "to the last page"; null for "". */
export function parsePages(text: string | undefined): PageRange[] | null {
  if (!text) return null
  const ranges: PageRange[] = []
  for (const raw of text.split(',')) {
    const part = raw.trim()
    if (part.includes('-')) {
      const pieces = part.split('-')
      if (pieces.length !== 2) throw new Error(`invalid page range ${JSON.stringify(part)}`)
      const [start, end] = pieces as [string, string]
      ranges.push([start ? pyInt(start) : 1, end ? pyInt(end) : -1])
    } else {
      const page = pyInt(part)
      ranges.push([page, page])
    }
  }
  return ranges
}

/** should_translate_page for a 1-based page number. */
export function shouldTranslatePage(ranges: readonly PageRange[] | null, page: number): boolean {
  if (ranges && ranges.length === 0) return false
  if (!ranges) return true
  return ranges.some(([start, end]) => start <= page && (end === -1 || page <= end))
}

/** 0-based pages a range text selects in a document of `total` pages; null means all. */
export function selectedPages(text: string | undefined, total: number): number[] | null {
  const ranges = parsePages(text)
  if (!ranges) return null
  const out: number[] = []
  for (let i = 0; i < total; i += 1) if (shouldTranslatePage(ranges, i + 1)) out.push(i)
  return out
}

/** A message for the page-range field, or null when the text is valid (empty means all). */
export function pageRangeProblem(text: string): string | null {
  if (!text.trim()) return null
  try {
    const ranges = parsePages(text.trim())
    if (ranges?.some(([start, end]) => start < 1 || (end !== -1 && end < start))) {
      return '页码从 1 开始，范围的结束页不能小于开始页'
    }
    return null
  } catch {
    return '页码格式不对，例如 1-3,5,8-'
  }
}
