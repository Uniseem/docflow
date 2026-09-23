import { flushSync } from 'react-dom'
import { create } from 'zustand'
import { isActiveStatus } from '../../../shared/library-filter'
import type { DocumentSummary } from '../../../shared/types'
import { invoke } from '../../api/invoke'
import { useDocumentsStore } from '../../store/documents'
import { useUiStore, type ConfirmState } from '../../store/ui'

/** Documents whose deletion is in flight; DocumentDetail unloads their PDF previews. */
export const useDeletingStore = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }))

/**
 * Every delete should go through here (06 §6.4): the PDF previews of these documents are
 * switched to about:blank and committed before main removes the files, so the embedded viewer
 * does not hold them open (Windows refuses to delete open files).
 */
export async function deleteDocuments(ids: string[]): Promise<{ deleted: string[] }> {
  flushSync(() => {
    useDeletingStore.setState((state) => ({ ids: new Set([...state.ids, ...ids]) }))
  })
  try {
    return await invoke('documents:delete', { ids })
  } catch (error) {
    // Deleted documents disappear with document:removed; the rest get their previews back.
    useDeletingStore.setState((state) => {
      const next = new Set(state.ids)
      for (const id of ids) next.delete(id)
      return { ids: next }
    })
    throw error
  }
}

/** Clears the global confirm only while it is still `confirm` (never a newer one). */
export function closeConfirm(confirm: ConfirmState): void {
  const ui = useUiStore.getState()
  if (ui.confirm === confirm) ui.setConfirm(null)
}

/**
 * Asks before cancelling. The question is moot once the document stops being active (it
 * completed or failed while the dialog was open), so the dialog then closes by itself instead of
 * letting a stale confirmation cancel a finished document.
 */
export function confirmCancel(item: Pick<DocumentSummary, 'id' | 'title'>): void {
  const confirm: ConfirmState = {
    title: `取消处理“${item.title}”？`,
    body: '正在进行的解析、翻译或排版会停止。源文件和已完成的翻译断点会保留，之后可以重新处理。',
    confirmLabel: '取消处理',
    cancelLabel: '继续处理',
    danger: true,
    onConfirm: async () => {
      await invoke('documents:cancel', { id: item.id })
      closeConfirm(confirm)
    },
  }
  useUiStore.getState().setConfirm(confirm)
  const offDocuments = useDocumentsStore.subscribe((state) => {
    const current = state.items.get(item.id)
    if (!current || !isActiveStatus(current.status)) closeConfirm(confirm)
  })
  const offUi = useUiStore.subscribe((state) => {
    if (state.confirm === confirm) return
    offDocuments()
    offUi()
  })
}

export function confirmDelete(item: Pick<DocumentSummary, 'id' | 'title'>): void {
  const confirm: ConfirmState = {
    title: `删除“${item.title}”？`,
    body: '译文、PDF、处理记录和文档库里的源文件副本都会被删除，你最初选择的文件不受影响。此操作无法撤销。',
    confirmLabel: '删除',
    danger: true,
    onConfirm: async () => {
      await deleteDocuments([item.id])
      closeConfirm(confirm)
    },
  }
  useUiStore.getState().setConfirm(confirm)
}
