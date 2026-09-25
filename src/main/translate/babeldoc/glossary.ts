// BabelDOC 0.6.4 glossary.py: Glossary / GlossaryEntry, CSV import and export, and the terms a
// text contains. hyperscan runs with HS_FLAG_CASELESS (no UTF8/UCP flag), so only ASCII letters
// fold; entries are escaped literals matched anywhere in the text.

export type GlossaryEntry = { source: string; target: string; targetLanguage?: string }

/** Glossary.normalize_source: lowercase, whitespace runs to one space, strip. */
export function normalizeSource(term: string): string {
  return term.toLowerCase().replace(/\s+/gu, ' ').trim()
}

function asciiFold(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

export class Glossary {
  readonly name: string
  readonly entries: GlossaryEntry[]
  readonly normalizedLookup = new Map<string, [string, string]>()
  readonly #folded: string[]

  constructor(name: string, entries: readonly GlossaryEntry[]) {
    this.name = name
    const seen = new Set<string>()
    this.entries = []
    for (const entry of entries) {
      const key = normalizeSource(entry.source)
      if (seen.has(key)) continue
      seen.add(key)
      this.entries.push(entry)
    }
    for (const entry of this.entries) {
      this.normalizedLookup.set(normalizeSource(entry.source), [entry.source, entry.target])
    }
    this.#folded = this.entries.map((entry) => asciiFold(entry.source))
  }

  /** get_active_entries_for_text: (source, target) of every entry found in `text`. */
  activeEntries(text: string): Array<[string, string]> {
    if (this.entries.length === 0 || !text) return []
    const haystack = asciiFold(text.replace(/\s+/gu, ' '))
    if (!haystack) return []
    const out: Array<[string, string]> = []
    this.entries.forEach((entry, i) => {
      const needle = this.#folded[i]!
      if (needle && haystack.includes(needle)) out.push([entry.source, entry.target])
    })
    return out
  }

  /** to_csv: source,target,tgt_lng with a header, doublequote quoting. */
  toCsv(): string {
    const rows = [['source', 'target', 'tgt_lng']]
    for (const entry of this.entries) {
      rows.push([entry.source, entry.target, entry.targetLanguage ?? ''])
    }
    return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
  }
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** Python csv.reader with the default dialect (doublequote, quotechar '"'). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  let started = false
  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      started = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      started = true
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (started || field !== '' || row.length > 0) {
        row.push(field)
        rows.push(row)
      }
      row = []
      field = ''
      started = false
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    started = true
    i += 1
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export class GlossaryFormatError extends Error {}

/**
 * Glossary.from_csv: needs `source` and `target` columns; a row whose non-empty `tgt_lng`
 * (lowercased, `-` → `_`) differs from the target language is skipped. chardet's guess is
 * replaced by UTF-8 (with or without BOM), then GB18030 when UTF-8 does not decode.
 */
export function glossaryFromCsv(name: string, bytes: Uint8Array, langOut: string): Glossary {
  const text = decodeCsv(bytes)
  const rows = parseCsv(text)
  const header = rows[0] ?? []
  const col = (key: string) => header.indexOf(key)
  const source = col('source')
  const target = col('target')
  const lang = col('tgt_lng')
  if (source < 0 || target < 0) {
    throw new GlossaryFormatError('术语表 CSV 必须包含 source 和 target 两列')
  }
  const wanted = langOut.toLowerCase().replaceAll('-', '_')
  const entries: GlossaryEntry[] = []
  for (const row of rows.slice(1)) {
    // csv.DictReader fills missing fields with None; an empty source is still an entry.
    const src = row[source] ?? ''
    const tgt = row[target] ?? ''
    const tgtLng = lang >= 0 ? (row[lang] ?? '') : ''
    if (tgtLng.trim() && tgtLng.trim().toLowerCase().replaceAll('-', '_') !== wanted) continue
    entries.push(
      tgtLng ? { source: src, target: tgt, targetLanguage: tgtLng } : { source: src, target: tgt },
    )
  }
  return new Glossary(name, entries)
}

function decodeCsv(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.startsWith('\ufeff') ? text.slice(1) : text
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}
