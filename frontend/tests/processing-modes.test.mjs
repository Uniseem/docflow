import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/processingModes.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { acceptedExtensions, documentDownloads, initialProcessingMode, nativePdfPreviewUrl, nativePdfStageLabel, processingModeAvailable, processingModeLabel, validateUpload } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function config(overrides = {}) {
  return {
    accepting_uploads: false,
    mineru_configured: false,
    translation_available: true,
    google_configured: true,
    deepseek_configured: true,
    default_processing_mode: 'mineru',
    max_upload_mb: 200,
    accepted_extensions: ['.pdf', '.docx', '.pptx', '.xlsx', '.png', '.html'],
    processing_modes: {
      mineru: { available: false, accepted_extensions: ['.pdf', '.docx', '.pptx', '.xlsx', '.png', '.html'], native_pdf_only: false },
      pdf2zh: { available: true, accepted_extensions: ['.pdf'], native_pdf_only: true },
    },
    ...overrides,
  }
}

const document = {
  id: 'document-id', status: 'completed', processing_mode: 'mineru',
  markdown_available: { original: true, translated: true, normalized: true },
  pdf_available: true,
  pdf_variants_available: { journal: true, mono: false, dual: false },
}

test('native PDF availability is independent of the legacy MinerU upload flag and key', () => {
  const nativeOnly = config()
  assert.equal(processingModeAvailable(nativeOnly, 'pdf2zh'), true)
  assert.equal(processingModeAvailable(nativeOnly, 'mineru'), false)
  assert.equal(initialProcessingMode(nativeOnly), 'pdf2zh')
})

test('uses the requested default when available and only falls back to available modes', () => {
  const both = config()
  both.processing_modes.mineru.available = true
  assert.equal(initialProcessingMode(both), 'mineru')
  both.default_processing_mode = 'pdf2zh'
  assert.equal(initialProcessingMode(both), 'pdf2zh')
  both.processing_modes.pdf2zh.available = false
  assert.equal(initialProcessingMode(both), 'mineru')
  both.processing_modes.mineru.available = false
  assert.equal(initialProcessingMode(both), 'pdf2zh')
})

test('legacy config supports existing MinerU deployments but never invents native availability', () => {
  const legacy = config({ processing_modes: undefined, default_processing_mode: undefined, accepting_uploads: true })
  assert.equal(processingModeAvailable(legacy, 'mineru'), true)
  assert.equal(processingModeAvailable(legacy, 'pdf2zh'), false)
  assert.equal(processingModeAvailable(null, 'pdf2zh'), false)
  assert.equal(initialProcessingMode(legacy), 'mineru')
  assert.deepEqual(acceptedExtensions(legacy, 'mineru'), legacy.accepted_extensions)
})

test('explicit capabilities take precedence over stale legacy upload flags', () => {
  assert.equal(processingModeAvailable(config({ accepting_uploads: true }), 'mineru'), false)
})

test('native PDF remains PDF-only even if the advertised extension list is too broad', () => {
  const value = config()
  value.processing_modes.pdf2zh.accepted_extensions.push('.docx')
  assert.deepEqual(acceptedExtensions(value, 'pdf2zh'), ['.pdf'])
  assert.equal(validateUpload({ name: '论文.PDF', size: 100 }, value, 'pdf2zh'), '')
  for (const name of ['论文.docx', 'image.png', 'paper.pdf.docx', 'README']) {
    assert.match(validateUpload({ name, size: 100 }, value, 'pdf2zh'), /仅支持 \.pdf/)
  }
})

test('an existing file is revalidated on every mode change without losing MinerU formats', () => {
  const selected = { name: '报告.docx', size: 1024 }
  assert.equal(validateUpload(selected, config(), 'mineru'), '')
  assert.match(validateUpload(selected, config(), 'pdf2zh'), /切换为 MinerU/)
  assert.equal(validateUpload(selected, config(), 'mineru'), '')
  for (const extension of ['.pptx', '.xlsx', '.png', '.html']) {
    assert.equal(validateUpload({ name: `报告${extension}`, size: 1024 }, config(), 'mineru'), '')
  }
})

test('both modes apply current server size limits and reject empty or unvalidated files', () => {
  const value = config({ max_upload_mb: 1 })
  for (const mode of ['mineru', 'pdf2zh']) {
    assert.equal(validateUpload({ name: 'file.pdf', size: 1048576 }, value, mode), '')
    assert.match(validateUpload({ name: 'file.pdf', size: 1048577 }, value, mode), /不能超过 1 MB/)
    assert.match(validateUpload({ name: 'file.pdf', size: 0 }, value, mode), /文件为空/)
    assert.match(validateUpload({ name: 'file.pdf', size: 1024 }, null, mode), /读取服务配置/)
  }
})

test('MinerU download order and URLs remain Markdown, PDF, then all files', () => {
  const downloads = documentDownloads(document)
  assert.deepEqual(downloads.map((item) => item.label), ['下载 Markdown', '下载 PDF', '下载所有文件'])
  assert.deepEqual(downloads.map((item) => item.href), ['/api/v1/jobs/document-id/markdown?variant=normalized', '/api/v1/jobs/document-id/pdf', '/api/v1/jobs/document-id/bundle'])
  assert.equal(downloads[0].primary, true)
  assert.deepEqual(documentDownloads({ ...document, processing_mode: undefined, pdf_variants_available: undefined }), downloads)
})

test('native PDF exposes only mono, dual and bundle in the required order', () => {
  const native = { ...document, processing_mode: 'pdf2zh', pdf_variants_available: { journal: false, mono: true, dual: true } }
  const downloads = documentDownloads(native)
  assert.deepEqual(downloads.map((item) => item.label), ['下载中文 PDF', '下载双语 PDF', '下载所有文件'])
  assert.deepEqual(downloads.map((item) => item.href), ['/api/v1/jobs/document-id/pdf?variant=mono', '/api/v1/jobs/document-id/pdf?variant=dual', '/api/v1/jobs/document-id/bundle'])
  assert.equal(downloads[0].primary, true)
  assert.equal(downloads.some((item) => item.kind === 'markdown'), false)
})

test('downloads only expose available variants and never guess a native mono PDF from the legacy flag', () => {
  const native = { ...document, processing_mode: 'pdf2zh', pdf_variants_available: { journal: false, mono: false, dual: true } }
  assert.deepEqual(documentDownloads(native).map((item) => item.key), ['dual', 'bundle'])
  assert.deepEqual(documentDownloads({ ...document, markdown_available: undefined, pdf_variants_available: { journal: false, mono: false, dual: false } }).map((item) => item.key), ['bundle'])
  assert.deepEqual(documentDownloads({ ...native, status: 'processing' }), [])
  assert.deepEqual(documentDownloads(null), [])
})

test('PDF preview is an explicit native mono inline URL, never a MinerU replacement', () => {
  const native = { ...document, processing_mode: 'pdf2zh', pdf_variants_available: { journal: false, mono: true, dual: true } }
  assert.equal(nativePdfPreviewUrl(native), '/api/v1/jobs/document-id/pdf?variant=mono&inline=true')
  assert.equal(nativePdfPreviewUrl(document), null)
  assert.equal(nativePdfPreviewUrl({ ...native, status: 'processing' }), null)
  assert.equal(nativePdfPreviewUrl({ ...native, pdf_variants_available: { mono: false, dual: true } }), null)
  assert.equal(nativePdfPreviewUrl(null), null)
})

test('mode labels cover both flows and safely label legacy documents as MinerU', () => {
  assert.equal(processingModeLabel('mineru'), 'MinerU 解析翻译')
  assert.equal(processingModeLabel('pdf2zh'), 'PDF 原生翻译')
  assert.equal(processingModeLabel(), 'MinerU 解析翻译')
})

test('timeline labels recognize native stage prefixes and their detailed substeps', () => {
  const labels = { preflight: 'PDF 文本层检查', layout: 'PDF 版面分析', translation: 'PDF 原文翻译', typesetting: 'PDF 译文排版', verified: 'PDF 结果校验' }
  for (const [stage, label] of Object.entries(labels)) {
    assert.equal(nativePdfStageLabel(`pdf2zh_${stage}`), label)
    assert.equal(nativePdfStageLabel(`pdf2zh_${stage}_page_completed`), label)
  }
  assert.equal(nativePdfStageLabel('translation_chunk_completed'), undefined)
  assert.equal(nativePdfStageLabel('pdf2zh_layoutunknown'), undefined)
})
