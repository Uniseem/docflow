import type { DocumentStatus, Stage } from '../../shared/types'

export const STATUS_LABEL: Record<DocumentStatus, string> = {
  queued: '排队中',
  processing: '处理中',
  retrying: '等待重试',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export const STATUS_COLOR: Record<
  DocumentStatus,
  'default' | 'accent' | 'warning' | 'success' | 'danger'
> = {
  queued: 'default',
  processing: 'accent',
  retrying: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'default',
}

export type StageInfo = {
  id: Stage
  name: string
  detail: string
  from: number
  to: number
}

export const STAGES: StageInfo[] = [
  { id: 'received', name: '接收与排队', detail: '复制源文件并加入处理队列', from: 0, to: 2 },
  { id: 'inspect', name: '检查 PDF', detail: '检查文本层，拒绝扫描件与加密文件', from: 3, to: 9 },
  { id: 'analyze', name: '分析版面', detail: '版面检测，识别段落与公式', from: 10, to: 29 },
  { id: 'translate', name: '翻译段落', detail: '共享任务池并发翻译', from: 30, to: 79 },
  {
    id: 'compose',
    name: '排版译文',
    detail: '改写页面内容流，写入译文并重绘公式',
    from: 80,
    to: 89,
  },
  { id: 'verify', name: '校验结果', detail: '检查两份 PDF 的页数、尺寸与可读性', from: 90, to: 93 },
  { id: 'archive', name: '保存到文档库', detail: '写入译文、PDF 与处理记录', from: 94, to: 100 },
]

export function stageName(stage: Stage): string {
  if (stage === 'done') return '已完成'
  return STAGES.find((item) => item.id === stage)?.name ?? stage
}

export function progressLabel(status: DocumentStatus, progress: number): string {
  if (status === 'queued') return '排队中'
  if (status === 'retrying') return `等待重试 · ${Math.round(progress)}%`
  if (status === 'processing') return `处理中 · ${Math.round(progress)}%`
  return `${Math.round(progress)}%`
}

export function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : path
}

export function fileStem(filename: string): string {
  return filename.replace(/\.pdf$/i, '')
}

export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0
  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString(undefined, { hour12: false })
}
