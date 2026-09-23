import { readFile } from 'node:fs/promises'
import type { PDFFont } from '@cantoo/pdf-lib'
import {
  ComposeRequest,
  ComposeResult,
  type Glyph,
  type Paragraph,
} from '../../../shared/pdf-types'
import { PDF } from '../../../shared/pdf-constants'
import { writeFileAtomic } from '../../settings/atomic-write'
import { loadPdfLib } from '../load-pdf-lib'
import { walkTextOps } from './content-walker'
import { buildDualPdf } from './dual'
import { emitPageOps, wrapPageContent } from './emit'
import { embedCjkFonts, mapOriginalFonts } from './fonts'
import { layoutParagraph } from './layout'
import {
  loadPageGraph,
  mountFont,
  noteFormPath,
  rewriteStream,
  writePageContents,
} from './resources'
import { deletionSet, shouldSkipPage, spliceRanges, type Warning } from './rewrite'

export type ComposeOutput = ComposeResult & { writtenPages: number[] }

export async function composePdf(input: ComposeRequest): Promise<ComposeOutput> {
  const request = ComposeRequest.parse(input)
  const sourceBytes = await readFile(request.sourcePath)
  const doc = await loadPdfLib(sourceBytes)
  const translations = new Map(request.translations.map((row) => [row.id, row]))
  const needBold = request.analysis.paragraphs.some((para) => {
    const tr = translations.get(para.id)
    return para.translatable && para.bold && tr && !tr.kept
  })
  const {
    regular,
    bold,
    warnings: fontWarnings,
  } = await embedCjkFonts(doc, request.fonts, needBold)
  const warnings: Warning[] = [...fontWarnings]
  const sourceTitle = doc.getTitle()
  if (sourceTitle) doc.setTitle(`${sourceTitle}（中文）`)
  else doc.setTitle('（中文）')

  let paragraphsWritten = 0
  let paragraphsKept = 0
  let opsRemoved = 0
  let runsRedrawn = 0
  const writtenPages: number[] = []

  const pages = doc.getPages()
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!
    const pageParas = request.analysis.paragraphs.filter((para) => para.page === pageIndex)
    const shared = new Set(
      request.analysis.forms
        .filter((form) => form.page === pageIndex && form.shared)
        .map((form) => form.formPath),
    )
    const graph = loadPageGraph(doc, page)
    const ops = walkTextOps(graph.content, {
      getForm: graph.getForm,
      shared,
      onForm: (path, form) => {
        noteFormPath(graph, path, form, doc)
      },
    })
    const kept = new Set<string>()
    const layouts = new Map<string, ReturnType<typeof layoutParagraph>>()

    for (const para of pageParas) {
      const tr = translations.get(para.id)
      if (!para.translatable || tr?.kept) {
        kept.add(para.id)
        paragraphsKept += 1
        continue
      }
      const text = tr?.text ?? para.text
      try {
        const font = para.bold && bold ? bold : regular
        const layout = layoutParagraph(
          para,
          text,
          (s, size) => widthOf(font, s, size),
          request.options,
        )
        layouts.set(para.id, layout)
        if (layout.overflow) {
          warnings.push({
            paragraphId: para.id,
            page: pageIndex,
            code: 'overflow',
            message: 'translation overflowed the original box',
          })
        }
      } catch {
        kept.add(para.id)
        paragraphsKept += 1
        warnings.push({
          paragraphId: para.id,
          page: pageIndex,
          code: 'layout_failed',
          message: 'layout failed; original text kept',
        })
      }
    }

    const formulaGlyphs = pageParas.flatMap((para) => para.runs.flatMap((run) => run.glyphs))
    const aliases = mapOriginalFonts(ops, formulaGlyphs, graph, request.analysis.fontMap)
    for (const para of pageParas) {
      if (kept.has(para.id) || para.runs.length === 0) continue
      const missing = para.runs.some((run) =>
        run.glyphs.some((g: Glyph) => !aliases.has(g.fontKey)),
      )
      if (missing) {
        kept.add(para.id)
        layouts.delete(para.id)
        paragraphsKept += 1
        warnings.push({
          paragraphId: para.id,
          page: pageIndex,
          code: 'font_unmapped',
          message: 'original formula font could not be mapped',
        })
      }
    }

    const targets = pageParas.filter((para) => para.translatable && !kept.has(para.id))
    if (targets.length === 0) continue

    const { deleted, expected, mismatch } = deletionSet(ops, targets)
    if (mismatch) {
      warnings.push({
        page: pageIndex,
        code: 'op_mismatch',
        message: `deleted ${deleted.length} ops, expected ${expected}`,
      })
    }
    if (shouldSkipPage(deleted.length, expected)) {
      warnings.push({
        page: pageIndex,
        code: 'page_skipped',
        message: 'too many operator mismatches; page kept',
      })
      continue
    }

    mountFont(page, 'DFcjk', regular.ref)
    if (bold) mountFont(page, 'DFcjkb', bold.ref)
    for (const mapped of aliases.values()) mountFont(page, mapped.alias, mapped.ref)

    const byPath = new Map<string, Array<[number, number]>>()
    for (const op of deleted) {
      const list = byPath.get(op.formPath) ?? []
      list.push(op.tokenRange)
      byPath.set(op.formPath, list)
    }
    let pageBytes = graph.content
    for (const [path, ranges] of byPath) {
      if (!path) {
        pageBytes = spliceRanges(graph.content, ranges)
        continue
      }
      const form = graph.formByPath.get(path)
      if (!form || shared.has(path)) continue
      rewriteStream(doc, form, spliceRanges(form.content, ranges))
    }

    const encode = (text: string, isBold: boolean) => {
      const font = isBold && bold ? bold : regular
      return font.encodeText(text).toString()
    }
    let appended: string
    try {
      appended = emitPageOps(targets, layouts, encode, aliases, (isBold) =>
        isBold && bold ? 'DFcjkb' : 'DFcjk',
      )
    } catch {
      for (const para of targets) {
        warnings.push({
          paragraphId: para.id,
          page: pageIndex,
          code: 'encode_failed',
          message: 'failed to encode translation',
        })
      }
      continue
    }

    writePageContents(page, wrapPageContent(pageBytes, appended))
    paragraphsWritten += targets.length
    opsRemoved += deleted.length
    runsRedrawn += targets.reduce((n, para: Paragraph) => n + para.runs.length, 0)
    writtenPages.push(pageIndex)
  }

  const monoBytes = await doc.save({ useObjectStreams: true })
  await writeFileAtomic(request.monoPath, monoBytes)
  let dualBytes: number | null = null
  if (request.dualPath) {
    const dual = await buildDualPdf(sourceBytes, monoBytes, sourceTitle)
    await writeFileAtomic(request.dualPath, dual)
    dualBytes = dual.length
  }

  const result = ComposeResult.parse({
    monoBytes: monoBytes.length,
    dualBytes,
    paragraphsWritten,
    paragraphsKept,
    opsRemoved,
    runsRedrawn,
    warnings,
  })
  return { ...result, writtenPages }
}

export function defaultComposeOptions() {
  return {
    minFontScale: PDF.MIN_FONT_SCALE,
    lineHeightFactor: PDF.LINE_HEIGHT_FACTOR,
    minLineHeightFactor: PDF.MIN_LINE_HEIGHT_FACTOR,
  }
}

function widthOf(font: PDFFont, text: string, size: number): number {
  if (!text) return 0
  return font.widthOfTextAtSize(text, size)
}
