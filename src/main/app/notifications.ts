import type { DocumentStatus } from '../../shared/types'

export function notifyIfBackground(input: {
  enabled: boolean
  focused: boolean
  status: DocumentStatus
  title: string
}): { title: string; body: string } | null {
  if (!input.enabled || input.focused) return null
  if (input.status === 'completed') return { title: '翻译完成', body: input.title }
  if (input.status === 'failed') return { title: '处理失败', body: input.title }
  return null
}

export function dockBadge(activeCount: number): string {
  return activeCount > 0 ? String(activeCount) : ''
}

export function overallProgress(progresses: number[]): number {
  if (progresses.length === 0) return -1
  const sum = progresses.reduce((total, value) => total + value, 0)
  return Math.min(1, Math.max(0, sum / progresses.length / 100))
}
