// Document outline (bookmarks) read and rewritten with pdf-lib's object model: what PyMuPDF's
// get_toc / set_toc give BabelDOC's migrate_toc, and what delete_pages does to the TOC.
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFDocument,
  type PDFObject,
} from '@cantoo/pdf-lib'

export type OutlineItem = {
  title: string
  /** Target page index in the source document, or null when it has no page destination. */
  page: number | null
  /** The destination array after the page: /XYZ left top zoom, /Fit, … */
  params: PDFObject[]
  open: boolean
  children: OutlineItem[]
}

function lookup(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : value
}

function textOf(value: PDFObject | undefined): string {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText()
  return ''
}

function nameTreeLookup(
  doc: PDFDocument,
  node: PDFDict | undefined,
  key: string,
  depth = 0,
): PDFObject | undefined {
  if (!node || depth > 32) return undefined
  const names = lookup(doc, node.get(PDFName.of('Names')))
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      if (textOf(lookup(doc, names.get(i))) === key) return lookup(doc, names.get(i + 1))
    }
  }
  const kids = lookup(doc, node.get(PDFName.of('Kids')))
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i += 1) {
      const kid = lookup(doc, kids.get(i))
      const found = kid instanceof PDFDict ? nameTreeLookup(doc, kid, key, depth + 1) : undefined
      if (found) return found
    }
  }
  return undefined
}

/** An explicit destination array for a /Dest or GoTo /D value (named ones resolved). */
function explicitDest(doc: PDFDocument, value: PDFObject | undefined): PDFArray | undefined {
  const dest = lookup(doc, value)
  if (dest instanceof PDFArray) return dest
  let name: string | undefined
  if (dest instanceof PDFName) name = dest.decodeText()
  else if (dest instanceof PDFString || dest instanceof PDFHexString) name = dest.decodeText()
  if (name === undefined) return undefined
  const catalog = doc.catalog
  const legacy = lookup(doc, catalog.get(PDFName.of('Dests')))
  let found: PDFObject | undefined
  if (legacy instanceof PDFDict) found = lookup(doc, legacy.get(PDFName.of(name)))
  if (!found) {
    const namesDict = lookup(doc, catalog.get(PDFName.of('Names')))
    const tree =
      namesDict instanceof PDFDict ? lookup(doc, namesDict.get(PDFName.of('Dests'))) : undefined
    found = tree instanceof PDFDict ? nameTreeLookup(doc, tree, name) : undefined
  }
  if (found instanceof PDFDict) found = lookup(doc, found.get(PDFName.of('D')))
  return found instanceof PDFArray ? found : undefined
}

export function readOutline(doc: PDFDocument): OutlineItem[] {
  const pageIndex = new Map<string, number>()
  doc.getPages().forEach((page, i) => pageIndex.set(page.ref.tag, i))
  const root = lookup(doc, doc.catalog.get(PDFName.of('Outlines')))
  if (!(root instanceof PDFDict)) return []
  const seen = new Set<PDFObject>()
  const walk = (first: PDFObject | undefined, depth: number): OutlineItem[] => {
    const out: OutlineItem[] = []
    let node = lookup(doc, first)
    while (node instanceof PDFDict && !seen.has(node) && depth < 64) {
      seen.add(node)
      let destValue = node.get(PDFName.of('Dest'))
      if (!destValue) {
        const action = lookup(doc, node.get(PDFName.of('A')))
        if (action instanceof PDFDict) {
          const kind = lookup(doc, action.get(PDFName.of('S')))
          if (kind instanceof PDFName && kind.decodeText() === 'GoTo') {
            destValue = action.get(PDFName.of('D'))
          }
        }
      }
      const dest = explicitDest(doc, destValue)
      let page: number | null = null
      const params: PDFObject[] = []
      if (dest && dest.size() > 0) {
        const target = dest.get(0)
        if (target instanceof PDFRef) page = pageIndex.get(target.tag) ?? null
        else if (target instanceof PDFNumber) page = target.asNumber()
        for (let i = 1; i < dest.size(); i += 1) params.push(lookup(doc, dest.get(i)) ?? PDFNull)
      }
      const count = lookup(doc, node.get(PDFName.of('Count')))
      out.push({
        title: textOf(lookup(doc, node.get(PDFName.of('Title')))),
        page,
        params,
        open: !(count instanceof PDFNumber) || count.asNumber() >= 0,
        children: walk(node.get(PDFName.of('First')), depth + 1),
      })
      node = lookup(doc, node.get(PDFName.of('Next')))
    }
    return out
  }
  return walk(root.get(PDFName.of('First')), 0)
}

/** Where a source page landed: its page object, and how its coordinates moved. */
export type PageTarget = { ref: PDFRef; dx: number; dy: number; keepCoordinates: boolean }

function mapParams(params: readonly PDFObject[], target: PageTarget): PDFObject[] {
  const kind = params[0] instanceof PDFName ? params[0].decodeText() : ''
  if (!target.keepCoordinates) return [PDFName.of('Fit')]
  const shift = (value: PDFObject | undefined, d: number): PDFObject =>
    value instanceof PDFNumber ? PDFNumber.of(value.asNumber() + d) : (value ?? PDFNull)
  const rest = params.slice(1)
  switch (kind) {
    case 'XYZ':
      return [params[0]!, shift(rest[0], target.dx), shift(rest[1], target.dy), rest[2] ?? PDFNull]
    case 'FitH':
    case 'FitBH':
      return [params[0]!, shift(rest[0], target.dy)]
    case 'FitV':
    case 'FitBV':
      return [params[0]!, shift(rest[0], target.dx)]
    case 'FitR':
      return [
        params[0]!,
        shift(rest[0], target.dx),
        shift(rest[1], target.dy),
        shift(rest[2], target.dx),
        shift(rest[3], target.dy),
      ]
    default:
      return params.length > 0 ? [...params] : [PDFName.of('Fit')]
  }
}

/**
 * set_toc: replaces the document's outline. Items whose page has no target are dropped and
 * their children take their place (delete_pages keeps the rest of the TOC).
 */
export function writeOutline(
  doc: PDFDocument,
  items: readonly OutlineItem[],
  targetOf: (page: number) => PageTarget | undefined,
): void {
  const flatten = (list: readonly OutlineItem[]): Array<OutlineItem & { target: PageTarget }> =>
    list.flatMap((item) => {
      const target = item.page === null ? undefined : targetOf(item.page)
      if (!target) return flatten(item.children)
      return [{ ...item, target }]
    })
  const context = doc.context
  const build = (
    list: readonly OutlineItem[],
    parent: PDFRef,
  ): { refs: PDFRef[]; count: number } => {
    const kept = flatten(list)
    const refs = kept.map(() => context.nextRef())
    let count = 0
    kept.forEach((item, i) => {
      const children = build(item.children, refs[i]!)
      const dict = context.obj({})
      dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title))
      dict.set(PDFName.of('Parent'), parent)
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]!)
      if (i + 1 < refs.length) dict.set(PDFName.of('Next'), refs[i + 1]!)
      if (children.refs.length > 0) {
        dict.set(PDFName.of('First'), children.refs[0]!)
        dict.set(PDFName.of('Last'), children.refs[children.refs.length - 1]!)
        dict.set(PDFName.of('Count'), PDFNumber.of(item.open ? children.count : -children.count))
      }
      dict.set(
        PDFName.of('Dest'),
        context.obj([item.target.ref, ...mapParams(item.params, item.target)]),
      )
      context.assign(refs[i]!, dict)
      count += 1 + (item.open ? children.count : 0)
    })
    return { refs, count }
  }
  const rootRef = context.nextRef()
  const top = build(items, rootRef)
  if (top.refs.length === 0) {
    doc.catalog.delete(PDFName.of('Outlines'))
    return
  }
  const root = context.obj({})
  root.set(PDFName.of('Type'), PDFName.of('Outlines'))
  root.set(PDFName.of('First'), top.refs[0]!)
  root.set(PDFName.of('Last'), top.refs[top.refs.length - 1]!)
  root.set(PDFName.of('Count'), PDFNumber.of(top.count))
  context.assign(rootRef, root)
  doc.catalog.set(PDFName.of('Outlines'), rootRef)
}
