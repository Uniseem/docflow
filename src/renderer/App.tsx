import { Button, Drawer, SearchField, Toast } from '@heroui/react'
import { useEffect, useState } from 'react'
import { invoke } from './api/invoke'
import { adjacentDocumentId, subscribeDocuments, useDocumentsStore } from './store/documents'
import { subscribeSettings, useSettingsStore } from './store/settings'
import { useUiStore } from './store/ui'
import { DropOverlay, GlobalConfirm, LibraryView, RenameDialog } from './views/Library/LibraryView'
import { NewTranslationModal } from './views/NewTranslation/NewTranslationModal'
import { collectPdfDrop } from './lib/drop'
import { notify, notifyError } from './lib/notify'
import { applyTheme } from './lib/theme'
import { confirmDelete } from './views/Document/actions'
import { DocumentDetail } from './views/Document/DocumentDetail'
import { SettingsView } from './views/Settings/SettingsView'

// Hide the drop overlay if no dragover arrived for this long (a drag cancelled without
// dragleave would otherwise leave it covering the window).
const DRAG_IDLE_MS = 3_000

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)
}

/** ⌘ on macOS (Control there moves the caret in text fields), Ctrl on Windows. */
function commandKey(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
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
      if (name === 'settings') useUiStore.getState().openSettings()
      if (name === 'focus-search') useUiStore.getState().focusSearch()
    })
    void (async () => {
      try {
        const info = await invoke('app:info', {})
        useUiStore.getState().setAppInfo(info)
        applyTheme(info.theme)
        await useSettingsStore.getState().load()
        await useDocumentsStore.getState().list()
      } catch (error) {
        notifyError(error)
      }
      // PDFs from the command line, open-file or a second instance that arrived before this
      // window subscribed wait in main; from now on main pushes them via app:openFiles.
      try {
        const { paths } = await invoke('app:takePendingFiles', {})
        if (paths.length > 0) useUiStore.getState().openNewTranslation(paths)
      } catch (error) {
        notifyError(error)
      }
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
      const meta = commandKey(event)
      if (meta && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        useUiStore.getState().openNewTranslation()
        return
      }
      if (meta && event.key === ',') {
        event.preventDefault()
        useUiStore.getState().openSettings()
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
        confirmDelete(item)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (event.metaKey || event.ctrlKey || event.altKey || listShortcutBlocked(event)) return
        if (event.target instanceof HTMLElement && event.target.matches(ARROW_WIDGET_SELECTOR)) {
          return
        }
        const current = useDocumentsStore.getState().selectedId
        const next = adjacentDocumentId(current, event.key === 'ArrowDown' ? 1 : -1)
        if (!next) return
        event.preventDefault()
        // The list scrolls the new selection into view itself (also when virtualized).
        if (next !== current) useDocumentsStore.getState().select(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    // The overlay captures pointer events while shown (so drops over the PDF preview reach
    // us), so it must never outlive the drag: dragover repeats while a drag is over the
    // window, and mousemove only fires again once the drag has ended.
    let idle: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (idle) clearTimeout(idle)
      idle = undefined
      setDragging(false)
    }
    const onDragOver = (event: DragEvent) => {
      event.preventDefault()
      setDragging(true)
      if (idle) clearTimeout(idle)
      idle = setTimeout(stop, DRAG_IDLE_MS)
    }
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget) return
      stop()
    }
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      stop()
      const list = event.dataTransfer?.files
      if (!list || list.length === 0) return
      const { paths, ignored } = collectPdfDrop([...list])
      if (ignored > 0) notify.warning(`已忽略 ${ignored} 个非 PDF 文件`)
      if (paths.length > 0) useUiStore.getState().openNewTranslation(paths)
    }
    const onMouseMove = () => {
      if (idle) stop()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('mousemove', onMouseMove)
    return () => {
      if (idle) clearTimeout(idle)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('mousemove', onMouseMove)
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
            <LibraryView
              onOpenDetail={() => {
                if (useUiStore.getState().narrow) setDrawerOpen(true)
              }}
            />
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
