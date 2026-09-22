import { ERROR_CODES, UserError } from '../../shared/errors'
import { VerifyResult } from '../../shared/pdf-types'
import { openPdfDocument } from './pdfjs'

const CJK_RE = /[\u4e00-\u9fff]/

export async function verifyPdf(input: {
  monoPath: string
  dualPath: string | null
  pages: number
  writtenPages: number[]
}): Promise<VerifyResult> {
  const mono = await openPdfDocument(
    await (await import('node:fs/promises')).readFile(input.monoPath),
  )
  try {
    if (mono.numPages !== input.pages) {
      throw new UserError(
        ERROR_CODES.verify_failed,
        `mono pages ${mono.numPages} != ${input.pages}`,
      )
    }
    const monoSizes: Array<[number, number]> = []
    const translatedPagesWithoutCjk: number[] = []
    for (let i = 0; i < mono.numPages; i += 1) {
      const page = await mono.getPage(i + 1)
      const viewport = page.getViewport({ scale: 1, rotation: 0 })
      monoSizes.push([viewport.width, viewport.height])
      if (input.writtenPages.includes(i)) {
        await page.getOperatorList()
        const content = await page.getTextContent()
        const text = content.items.map((item) => ('str' in item ? item.str : '')).join('')
        if (!CJK_RE.test(text)) translatedPagesWithoutCjk.push(i)
      }
      page.cleanup()
    }
    if (translatedPagesWithoutCjk.length > 0) {
      throw new UserError(ERROR_CODES.verify_failed)
    }

    let dualPages: number | null = null
    let sizeMismatches = 0
    if (input.dualPath) {
      const dual = await openPdfDocument(
        await (await import('node:fs/promises')).readFile(input.dualPath),
      )
      try {
        dualPages = dual.numPages
        if (dual.numPages !== input.pages * 2) {
          throw new UserError(
            ERROR_CODES.verify_failed,
            `dual pages ${dual.numPages} != ${input.pages * 2}`,
          )
        }
        for (let i = 0; i < input.pages; i += 1) {
          const origPage = await dual.getPage(i * 2 + 1)
          const zhPage = await dual.getPage(i * 2 + 2)
          const orig = origPage.getViewport({ scale: 1, rotation: 0 })
          const zh = zhPage.getViewport({ scale: 1, rotation: 0 })
          const [mw, mh] = monoSizes[i] ?? [0, 0]
          if (Math.abs(orig.width - mw) > 1 || Math.abs(orig.height - mh) > 1) sizeMismatches += 1
          if (Math.abs(zh.width - mw) > 1 || Math.abs(zh.height - mh) > 1) sizeMismatches += 1
          origPage.cleanup()
          zhPage.cleanup()
        }
      } finally {
        await dual.cleanup()
      }
    }

    const { stat } = await import('node:fs/promises')
    if ((await stat(input.monoPath)).size <= 1024) {
      throw new UserError(ERROR_CODES.verify_failed, 'mono pdf too small')
    }

    return VerifyResult.parse({
      monoPages: input.pages,
      dualPages,
      sizeMismatches,
      translatedPagesWithoutCjk,
    })
  } finally {
    await mono.cleanup()
  }
}
