import type { DocumentDetail, ProcessingMode, PublicConfig } from './types'

export const processingModes = [
  {
    value: 'mineru',
    label: 'MinerU 解析翻译',
    description: '支持 PDF、Office、图片与 HTML，解析后生成 Markdown 和期刊式 PDF。',
    fileHint: '支持 PDF、Word、PowerPoint、Excel、图片与 HTML',
  },
  {
    value: 'pdf2zh',
    label: 'PDF 原生翻译',
    description: '仅支持带文本层的 PDF，保留页面版式，生成中文单语与双语 PDF。',
    fileHint: '仅支持带文本层的 PDF；扫描件请使用 MinerU 解析翻译',
  },
] as const

export function processingModeLabel(mode: ProcessingMode = 'mineru'): string {
  return processingModes.find((item) => item.value === mode)?.label || processingModes[0].label
}

export function processingModeAvailable(config: PublicConfig | null, mode: ProcessingMode): boolean {
  if (!config) return false
  // The legacy flag only describes MinerU; it must never gate the native PDF path.
  return config.processing_modes?.[mode]?.available ?? (mode === 'mineru' && config.accepting_uploads)
}

export function initialProcessingMode(config: PublicConfig): ProcessingMode {
  const preferred = config.default_processing_mode === 'pdf2zh' ? 'pdf2zh' : 'mineru'
  if (processingModeAvailable(config, preferred)) return preferred
  return processingModes.find((item) => processingModeAvailable(config, item.value))?.value || preferred
}

export function acceptedExtensions(config: PublicConfig | null, mode: ProcessingMode): string[] {
  // Native PDF must stay PDF-only even if a stale/malformed capability response is received.
  if (mode === 'pdf2zh') return ['.pdf']
  return config?.processing_modes?.mineru?.accepted_extensions ?? config?.accepted_extensions ?? []
}

export function validateUpload(file: Pick<File, 'name' | 'size'>, config: PublicConfig | null, mode: ProcessingMode): string {
  if (!config) return '正在读取服务配置，请稍后再选择文档。'
  const extension = file.name.match(/\.[^.]+$/)?.[0].toLowerCase() || ''
  if (!acceptedExtensions(config, mode).some((item) => item.toLowerCase() === extension)) {
    return mode === 'pdf2zh'
      ? 'PDF 原生翻译仅支持 .pdf 文件，请更换文件或切换为 MinerU 解析翻译。'
      : `暂不支持 ${extension || '无扩展名'} 文件`
  }
  if (file.size === 0) return '文件为空，请重新选择。'
  if (file.size > config.max_upload_mb * 1048576) return `文件不能超过 ${config.max_upload_mb} MB`
  return ''
}

export interface DocumentDownload {
  key: 'markdown' | 'journal' | 'mono' | 'dual' | 'bundle'
  kind: 'markdown' | 'pdf' | 'bundle'
  label: string
  href: string
  primary?: boolean
}

export function documentDownloads(document: DocumentDetail | null): DocumentDownload[] {
  if (!document || document.status !== 'completed') return []
  const base = `/api/v1/jobs/${encodeURIComponent(document.id)}`
  const downloads: DocumentDownload[] = []
  if (document.processing_mode === 'pdf2zh') {
    if (document.pdf_variants_available?.mono) downloads.push({ key: 'mono', kind: 'pdf', label: '下载中文 PDF', href: `${base}/pdf?variant=mono`, primary: true })
    if (document.pdf_variants_available?.dual) downloads.push({ key: 'dual', kind: 'pdf', label: '下载双语 PDF', href: `${base}/pdf?variant=dual` })
  } else {
    if (document.markdown_available?.normalized) downloads.push({ key: 'markdown', kind: 'markdown', label: '下载 Markdown', href: `${base}/markdown?variant=normalized`, primary: true })
    if (document.pdf_variants_available?.journal ?? document.pdf_available) downloads.push({ key: 'journal', kind: 'pdf', label: '下载 PDF', href: `${base}/pdf` })
  }
  downloads.push({ key: 'bundle', kind: 'bundle', label: '下载所有文件', href: `${base}/bundle` })
  return downloads
}

export function nativePdfPreviewUrl(document: DocumentDetail | null): string | null {
  if (document?.processing_mode !== 'pdf2zh' || document.status !== 'completed' || !document.pdf_variants_available?.mono) return null
  return `/api/v1/jobs/${encodeURIComponent(document.id)}/pdf?variant=mono&inline=true`
}

export const nativePdfStageLabels: Record<string, string> = {
  pdf2zh_preflight: 'PDF 文本层检查',
  pdf2zh_layout: 'PDF 版面分析',
  pdf2zh_translation: 'PDF 原文翻译',
  pdf2zh_typesetting: 'PDF 译文排版',
  pdf2zh_verified: 'PDF 结果校验',
}

export function nativePdfStageLabel(stage: string): string | undefined {
  const prefix = Object.keys(nativePdfStageLabels).find((key) => stage === key || stage.startsWith(`${key}_`))
  return prefix ? nativePdfStageLabels[prefix] : undefined
}
