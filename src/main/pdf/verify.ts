import { ERROR_CODES, UserError } from '../../shared/errors'
import { VerifyResult } from '../../shared/pdf-types'
import { openPdfDocument } from './pdfjs'

const CJK_RE = /[\u4e00-\u9fff]/

export async function verifyPdf(input: {
  monoPath: string
  dualPath: string | null
  pages: number
  writtenPages: number[]
  /** Side by side: one dual page per page; alternating: two. */
  dualMode?: 'side-by-side' | 'alternating'
}): Promise<VerifyResult> {
  const mono = await openPdfDocument(
    await (await import('node:fs/promises')).readFile(input.monoPath),
  )
  try {
    if (mono.numPages !== input.pages) {
      throw verifyFailed(`中文 PDF 有 ${mono.numPages} 页，原文有 ${input.pages} 页`)
    }
    const monoSizes: Array<[number, number]> = []
    const shownSizes: Array<[number, number]> = []
    const translatedPagesWithoutCjk: number[] = []
    for (let i = 0; i < mono.numPages; i += 1) {
      const page = await mono.getPage(i + 1)
      const viewport = page.getViewport({ scale: 1, rotation: 0 })
      monoSizes.push([viewport.width, viewport.height])
      const shown = page.getViewport({ scale: 1 })
      shownSizes.push([shown.width, shown.height])
      if (input.writtenPages.includes(i)) {
        await page.getOperatorList()
        const content = await page.getTextContent()
        const text = content.items.map((item) => ('str' in item ? item.str : '')).join('')
        if (!CJK_RE.test(text)) translatedPagesWithoutCjk.push(i)
      }
      page.cleanup()
    }
    if (translatedPagesWithoutCjk.length > 0) {
      const pages = translatedPagesWithoutCjk.map((i) => i + 1).join('、')
      throw verifyFailed(`第 ${pages} 页写入译文后没有中文`)
    }

    let dualPages: number | null = null
    let sizeMismatches = 0
    if (input.dualPath) {
      const dual = await openPdfDocument(
        await (await import('node:fs/promises')).readFile(input.dualPath),
      )
      try {
        dualPages = dual.numPages
        const sideBySide = (input.dualMode ?? 'alternating') === 'side-by-side'
        const expected = sideBySide ? input.pages : input.pages * 2
        if (dual.numPages !== expected) {
          throw verifyFailed(`双语 PDF 有 ${dual.numPages} 页，应为 ${expected} 页`)
        }
        for (let i = 0; sideBySide && i < input.pages; i += 1) {
          // Original and translation next to each other, both as displayed.
          const page = await dual.getPage(i + 1)
          const size = page.getViewport({ scale: 1 })
          const [w, h] = shownSizes[i] ?? [0, 0]
          if (Math.abs(size.width - 2 * w) > 2 || Math.abs(size.height - h) > 1) sizeMismatches += 1
          page.cleanup()
        }
        for (let i = 0; !sideBySide && i < input.pages; i += 1) {
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
      throw verifyFailed('中文 PDF 不足 1 KiB')
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

/** The reason is shown to the user, so it is Chinese; the result stays retryable. */
function verifyFailed(reason: string): UserError {
  return new UserError(
    ERROR_CODES.verify_failed,
    `生成的 PDF 未通过校验（${reason}），稍后自动重试。`,
  )
}
