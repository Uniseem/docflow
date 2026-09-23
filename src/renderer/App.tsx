import { Button, Drawer, SearchField, Toast, toast } from '@heroui/react'
import { useEffect, useState } from 'react'
import type { DocumentSummary } from '../shared/types'
import { invoke } from './api/invoke'
import { subscribeDocuments, useDocumentsStore } from './store/documents'
import { subscribeSettings, useSettingsStore } from './store/settings'
import { useUiStore } from './store/ui'
import { DropOverlay, GlobalConfirm, LibraryView, RenameDialog } from './views/Library/LibraryView'
import { NewTranslationModal } from './views/NewTranslation/NewTranslationModal'
import { collectPdfDrop } from './lib/drop'
import { DocumentDetail } from './views/Document/DocumentDetail'
import { SettingsView } from './views/Settings/SettingsView'

function applyTheme(theme: 'system' | 'light' | 'dark'): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
}

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)
}

// Mounted HeroUI overlays (modal/alert/drawer backdrops, dropdown/select popovers) own the
// keyboard; list shortcuts must not fire underneath them. Also matches while they animate out.
const OVERLAY_SELECTOR = [
  '[data-slot="modal-backdrop"]',
  '[data-slot="alert-dialog-backdrop"]',
  '[data-slot="drawer-backdrop"]',
  '[data-slot$="-popover"]',
  '[data-slot="popover-dialog"]',
].join(', ')

const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [role="slider"]'

// Focused widgets that already use the arrow keys for their own navigation.
const ARROW_WIDGET_SELECTOR =
  '[role="option"], [role="tab"], [role="radio"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="gridcell"], [role="row"], [role="treeitem"]'

function listShortcutBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return true
  if (useUiStore.getState().view !== 'library') return true
  if (document.querySelector(OVERLAY_SELECTOR)) return true
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return true
  return target.closest(TEXT_ENTRY_SELECTOR) !== null
}

// Same order as the library list (LibraryView sorts by updatedAt, newest first).
function visibleDocuments(): DocumentSummary[] {
  return [...useDocumentsStore.getState().items.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )
}

export default function App() {
  const view = useUiStore((s) => s.view)
  const theme = useUiStore((s) => s.theme)
  const engineReady = useUiStore((s) => s.engineReady)
  const newTranslationOpen = useUiStore((s) => s.newTranslationOpen)
  const query = useDocumentsStore((s) => s.query)
  const setQuery = useDocumentsStore((s) => s.setQuery)
  const selectedId = useDocumentsStore((s) => s.selectedId)
  const narrow = useUiStore((s) => s.narrow)
  const searchFocused = useUiStore((s) => s.searchFocused)
  const [dragging, setDragging] = useState(false)
  // In narrow windows the detail panel is a modal Drawer. It opens only on an explicit row
  // click: the documents store auto-selects on list/upsert, and tying the drawer to
  // selectedId alone would pop it open on launch and after every progress update.
  const [drawerOpen, setDrawerOpen] = useState(false)
  const detailDrawerOpen = narrow && view === 'library' && selectedId !== null && drawerOpen
  useEffect(() => {
    if (searchFocused > 0) document.getElementById('library-search')?.focus()
  }, [searchFocused])

  useEffect(() => {
    applyTheme(theme)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMedia = () => applyTheme(useUiStore.getState().theme)
    media.addEventListener('change', onMedia)
    return () => media.removeEventListener('change', onMedia)
  }, [theme])

  useEffect(() => {
    const onResize = () => useUiStore.getState().setNarrow(window.innerWidth < 1100)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!window.docflow) {
      useUiStore.setState({ engineReady: false })
      return
    }
    const offDocs = subscribeDocuments()
    const offSettings = subscribeSettings()
    const offFiles = window.docflow.on('app:openFiles', ({ paths }) => {
      useUiStore.getState().openNewTranslation(paths)
    })
    const offCommand = window.docflow.on('app:command', ({ name }) => {
      if (name === 'new-translation') useUiStore.getState().openNewTranslation()
      if (name === 'settings') useUiStore.getState().setView('settings')
      if (name === 'focus-search') useUiStore.getState().focusSearch()
    })
    void (async () => {
      const info = await invoke('app:info', {})
      useUiStore.getState().setAppInfo(info)
      applyTheme(info.theme)
      await useSettingsStore.getState().load()
      const settings = useSettingsStore.getState().view
      if (settings && !settings.capabilities.llmReady) {
        useUiStore.getState().setSettingsTab('providers')
      }
      await useDocumentsStore.getState().list()
    })()
    return () => {
      offDocs()
      offSettings()
      offFiles()
      offCommand()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        useUiStore.getState().openNewTranslation()
        return
      }
      if (meta && event.key === ',') {
        event.preventDefault()
        useUiStore.getState().setView('settings')
        return
      }
      if (meta && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        useUiStore.getState().focusSearch()
        return
      }
      if (event.key === 'Escape') {
        // Open dialogs/drawers handle Escape themselves (and stop it); this only covers
        // state that has no focused overlay.
        useUiStore.getState().setInfoOpen(false)
        setDrawerOpen(false)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (listShortcutBlocked(event)) return
        const id = useDocumentsStore.getState().selectedId
        const item = id ? useDocumentsStore.getState().items.get(id) : undefined
        if (!item) return
        event.preventDefault()
        useUiStore.getState().setConfirm({
          title: `删除“${item.title}”？`,
          body: '译文、PDF、处理记录和文档库里的源文件副本都会被删除，你最初选择的文件不受影响。此操作无法撤销。',
          confirmLabel: '删除',
          danger: true,
          onConfirm: async () => {
            await invoke('documents:delete', { ids: [item.id] })
            useUiStore.getState().setConfirm(null)
          },
        })
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (meta || event.altKey || listShortcutBlocked(event)) return
        if (event.target instanceof HTMLElement && event.target.matches(ARROW_WIDGET_SELECTOR)) {
          return
        }
        const docs = visibleDocuments()
        if (docs.length === 0) return
        const current = useDocumentsStore.getState().selectedId
        const index = docs.findIndex((item) => item.id === current)
        const next =
          index < 0
            ? 0
            : event.key === 'ArrowDown'
              ? Math.min(docs.length - 1, index + 1)
              : Math.max(0, index - 1)
        const item = docs[next]
        if (!item) return
        event.preventDefault()
        if (item.id !== current) useDocumentsStore.getState().select(item.id)
        document
          .querySelector(`[data-testid="document-row-${CSS.escape(item.id)}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      event.preventDefault()
      setDragging(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget) return
      setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const list = event.dataTransfer?.files
      if (!list || list.length === 0) return
      const { paths, ignored } = collectPdfDrop([...list])
      if (ignored > 0) toast.warning(`已忽略 ${ignored} 个非 PDF 文件`)
      if (paths.length > 0) useUiStore.getState().openNewTranslation(paths)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (!engineReady) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p>处理引擎未运行</p>
        <Button
          onPress={() => {
            if (window.docflow) void window.docflow.invoke('app:relaunch', {})
            else window.location.reload()
          }}
        >
          重新启动
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 px-3">
          <div className={isMac() ? 'w-20 shrink-0' : 'w-2 shrink-0'} />
          {view === 'settings' ? (
            <Button
              className="titlebar-no-drag"
              size="sm"
              variant="ghost"
              onPress={() => useUiStore.getState().setView('library')}
            >
              返回文档库
            </Button>
          ) : (
            <span className="text-sm font-medium">DocFlow</span>
          )}
          <div className="titlebar-no-drag ml-auto flex items-center gap-2">
            {view === 'library' ? (
              <>
                <SearchField
                  className="w-56"
                  value={query}
                  onChange={setQuery}
                  aria-label="搜索标题或文件名"
                >
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input id="library-search" placeholder="搜索标题或文件名" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
                <Button
                  variant="primary"
                  size="sm"
                  onPress={() => useUiStore.getState().openNewTranslation()}
                >
                  新建翻译
                </Button>
              </>
            ) : null}
          </div>
        </header>
        {view === 'settings' ? (
          <div className="flex min-h-0 flex-1">
            <SettingsView />
          </div>
        ) : (
          <div
            className="flex min-h-0 flex-1"
            onClick={(event) => {
              if (!useUiStore.getState().narrow) return
              // DOM ancestry only: clicks inside a row's portaled menu bubble here through the
              // React tree but are not inside the row element.
              const target = event.target as Element
              if (target.closest('button')) return
              if (target.closest('[data-testid^="document-row-"]')) setDrawerOpen(true)
            }}
          >
            <LibraryView />
            {!narrow && selectedId ? (
              <aside className="w-[52%] min-w-[480px] border-l border-separator">
                <DocumentDetail key={selectedId} />
              </aside>
            ) : null}
          </div>
        )}
      </div>
      {narrow ? (
        <Drawer.Backdrop
          isOpen={detailDrawerOpen}
          onOpenChange={(open) => {
            if (!open) setDrawerOpen(false)
          }}
        >
          <Drawer.Content placement="right">
            <Drawer.Dialog aria-label="文档详情" className="w-[min(52%,720px)] min-w-[480px] p-0">
              {/* Drawer.Body opts the content out of drag-to-dismiss (text selection, scrolling). */}
              <Drawer.Body className="m-0 flex flex-col overflow-hidden p-0 text-base leading-normal text-foreground">
                <DocumentDetail overlay key={selectedId} />
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      ) : null}
      <NewTranslationModal key={newTranslationOpen ? 'open' : 'closed'} />
      <RenameDialog />
      <GlobalConfirm />
      <DropOverlay visible={dragging} />
      <Toast.Provider placement="bottom end" />
    </>
  )
}
