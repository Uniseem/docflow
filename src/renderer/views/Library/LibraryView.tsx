import {
  Button,
  Chip,
  Dropdown,
  Input,
  Label,
  ListBox,
  Modal,
  ProgressBar,
  Separator,
  Spinner,
  TextField,
  useOverlayState,
} from '@heroui/react'
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FileUp,
  MoreHorizontal,
  Settings,
  Upload,
  XCircle,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { isActiveStatus } from '../../../shared/library-filter'
import { formatBytes, formatRelativeTime } from '../../../shared/text'
import type { DocumentStatus, DocumentSummary } from '../../../shared/types'
import { invoke } from '../../api/invoke'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { notifyError } from '../../lib/notify'
import { sortDocuments, useDocumentsStore } from '../../store/documents'
import { useSettingsStore } from '../../store/settings'
import { useUiStore, type ConfirmState } from '../../store/ui'
import { progressLabel, stageName } from '../../lib/labels'
import { confirmCancel, confirmDelete } from '../Document/actions'
import { rowHeight, rowOffsets, scrollTopFor, visibleRange } from './virtual-list'

const VIRTUAL_THRESHOLD = 200
const OVERSCAN_ROWS = 20
const RELATIVE_TIME_REFRESH_MS = 60_000

function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), RELATIVE_TIME_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function reportError(error: unknown): void {
  notifyError(error)
}

export function LibraryView(props: { onOpenDetail?: (id: string) => void }) {
  const itemsMap = useDocumentsStore((s) => s.items)
  const counts = useDocumentsStore((s) => s.counts)
  const filter = useDocumentsStore((s) => s.filter)
  const query = useDocumentsStore((s) => s.query)
  const selectedId = useDocumentsStore((s) => s.selectedId)
  const setFilter = useDocumentsStore((s) => s.setFilter)
  const select = useDocumentsStore((s) => s.select)
  const llmReady = useSettingsStore((s) => s.view?.capabilities.llmReady ?? false)
  const openNew = useUiStore((s) => s.openNewTranslation)
  const openSettings = useUiStore((s) => s.openSettings)
  const platform = useUiStore((s) => s.appInfo?.platform)
  const items = useMemo(() => sortDocuments(itemsMap.values()), [itemsMap])
  const now = useMinuteClock()

  const empty = counts.all === 0 && !query
  const filteredEmpty = items.length === 0 && !empty

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-separator">
        <ListBox
          aria-label="文档筛选"
          selectedKeys={new Set([filter])}
          onSelectionChange={(keys) => {
            // Selection can be the string 'all'; spreading it would yield characters.
            if (keys === 'all') return
            const key = [...keys][0]
            if (typeof key === 'string') {
              setFilter(key as typeof filter)
            }
          }}
          selectionMode="single"
          className="flex-1 p-2"
        >
          <FilterItem id="all" label="全部文档" count={counts.all} />
          <FilterItem id="active" label="进行中" count={counts.active} accent />
          <FilterItem id="completed" label="已完成" count={counts.completed} />
          <FilterItem id="failed" label="失败与取消" count={counts.failed} />
        </ListBox>
        <div className="p-2">
          <Button variant="ghost" className="w-full justify-start" onPress={() => openSettings()}>
            <Settings size={16} />
            设置
          </Button>
        </div>
      </aside>
      <section className="flex min-w-[360px] flex-1 flex-col">
        {empty ? (
          <EmptyLibrary
            llmReady={llmReady}
            onNew={() => openNew()}
            onAddProvider={() => openSettings('providers')}
          />
        ) : filteredEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm font-medium">没有符合条件的文档</p>
            <p className="text-sm text-foreground/60">试试其他筛选条件或搜索词。</p>
          </div>
        ) : (
          <DocumentList
            items={items}
            selectedId={selectedId}
            onSelect={select}
            onOpen={(id) => props.onOpenDetail?.(id)}
            platform={platform}
            now={now}
          />
        )}
      </section>
    </div>
  )
}

function FilterItem(props: { id: string; label: string; count: number; accent?: boolean }) {
  return (
    <ListBox.Item id={props.id} textValue={props.label} className="my-0.5">
      <div className="flex w-full items-center justify-between gap-2">
        <span>{props.label}</span>
        <Chip size="sm" color={props.accent && props.count > 0 ? 'accent' : 'default'}>
          {props.count}
        </Chip>
      </div>
    </ListBox.Item>
  )
}

function EmptyLibrary(props: { llmReady: boolean; onNew: () => void; onAddProvider: () => void }) {
  if (!props.llmReady) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-4 px-10 text-center"
        data-testid="library-empty"
      >
        <FileUp size={64} className="text-foreground/40" />
        <p className="max-w-md text-sm text-foreground/80">
          DocFlow 用大模型翻译。先在设置中添加一个服务商（DeepSeek、通义千问、Kimi、Claude
          等）并填写 API Key，再把文件拖到这里。
        </p>
        <Button variant="primary" onPress={props.onAddProvider}>
          添加大模型服务商…
        </Button>
      </div>
    )
  }
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-4 px-10 text-center"
      data-testid="library-empty"
    >
      <FileUp size={64} className="text-foreground/40" />
      <p className="text-sm">把 PDF 拖到这里，或点按“新建翻译”。</p>
      <Button variant="primary" onPress={props.onNew}>
        新建翻译…
      </Button>
    </div>
  )
}

function rowDomId(id: string): string {
  return `document-row-${id}`
}

function DocumentList(props: {
  items: DocumentSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  platform: 'darwin' | 'win32' | undefined
  now: Date
}) {
  const { items, selectedId } = props
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = items.length > VIRTUAL_THRESHOLD
  const offsets = useMemo(() => rowOffsets(items), [items])
  const [viewport, setViewport] = useState({ top: 0, height: 0 })

  useEffect(() => {
    const el = scroller.current
    if (!el || !virtual) return
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [virtual])

  // Keep the selected row in view whenever the selection changes (arrow keys, removal,
  // list refresh). Setting scrollTop directly also works for rows the virtual list has not
  // rendered yet.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || selectedId === null) return
    const index = items.findIndex((item) => item.id === selectedId)
    if (index < 0) return
    const next = scrollTopFor(offsets, index, el.scrollTop, el.clientHeight)
    if (next === null) return
    el.scrollTop = next
    if (virtual) setViewport({ top: el.scrollTop, height: el.clientHeight })
    // Only a selection change should scroll; progress updates must not move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const range = virtual
    ? visibleRange(offsets, viewport.top, viewport.height || 800, OVERSCAN_ROWS)
    : { start: 0, end: items.length }
  const slice = items.slice(range.start, range.end)
  const padTop = offsets[range.start] ?? 0
  const padBottom = Math.max(0, (offsets[items.length] ?? 0) - (offsets[range.end] ?? 0))
  const activeRendered = slice.some((item) => item.id === selectedId)

  function move(step: number | 'first' | 'last') {
    if (items.length === 0) return
    let index: number
    if (step === 'first') index = 0
    else if (step === 'last') index = items.length - 1
    else {
      const current = items.findIndex((item) => item.id === selectedId)
      index = current < 0 ? 0 : Math.min(items.length - 1, Math.max(0, current + step))
    }
    const next = items[index]
    if (next && next.id !== selectedId) props.onSelect(next.id)
  }

  return (
    <div
      ref={scroller}
      className="group min-h-0 flex-1 overflow-auto outline-none"
      role="listbox"
      aria-label="文档列表"
      tabIndex={0}
      data-testid="document-list"
      {...(selectedId && activeRendered ? { 'aria-activedescendant': rowDomId(selectedId) } : {})}
      onKeyDown={(event) => {
        // Keys pressed on a row's menu button belong to that button.
        if (event.target !== event.currentTarget) return
        if (event.metaKey || event.ctrlKey || event.altKey) return
        const steps: Record<string, number | 'first' | 'last'> = {
          ArrowDown: 1,
          ArrowUp: -1,
          PageDown: 10,
          PageUp: -10,
          Home: 'first',
          End: 'last',
        }
        const step = steps[event.key]
        if (step !== undefined) {
          event.preventDefault()
          move(step)
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (selectedId) props.onOpen(selectedId)
        }
      }}
    >
      <div style={{ height: padTop }} />
      {slice.map((item) => (
        <DocumentRow
          key={item.id}
          item={item}
          selected={item.id === selectedId}
          platform={props.platform}
          now={props.now}
          onSelect={() => props.onSelect(item.id)}
        />
      ))}
      <div style={{ height: padBottom }} />
    </div>
  )
}

function DocumentRow(props: {
  item: DocumentSummary
  selected: boolean
  platform: 'darwin' | 'win32' | undefined
  now: Date
  onSelect: () => void
}) {
  const { item } = props
  const setRename = useUiStore((s) => s.setRename)
  const subtitle = [
    item.translator.label,
    formatBytes(item.sourceSize),
    item.pages != null ? `${item.pages} 页` : null,
    formatRelativeTime(item.updatedAt, props.now),
  ]
    .filter(Boolean)
    .join(' · ')
  const active = isActiveStatus(item.status)

  return (
    <div
      id={rowDomId(item.id)}
      role="option"
      aria-selected={props.selected}
      data-testid={`document-row-${item.id}`}
      data-status={item.status}
      style={{ height: rowHeight(item) }}
      className={clsx(
        'flex cursor-default items-center overflow-hidden border-b border-separator px-3',
        props.selected &&
          'bg-accent/10 group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-inset',
      )}
      onClick={props.onSelect}
      onDoubleClick={() => {
        if (item.status === 'completed') {
          invoke('documents:openExternal', { id: item.id, kind: 'mono' }).catch(reportError)
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="mt-0.5 flex w-[18px] shrink-0 justify-center">
          <StatusIcon status={item.status} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.title}>
            {item.title}
          </p>
          <p className="truncate text-xs text-foreground/60">{subtitle}</p>
          {active ? (
            <div className="mt-1 flex items-center gap-2">
              <ProgressBar
                className="flex-1"
                size="sm"
                value={item.progress}
                minValue={0}
                maxValue={100}
                isIndeterminate={item.progress <= 3}
                aria-label="进度"
              >
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
              <span className="shrink-0 text-xs text-foreground/70">
                {progressLabel(item.status, item.progress)} · {stageName(item.stage)}
              </span>
            </div>
          ) : null}
        </div>
        <RowMenu
          item={item}
          platform={props.platform}
          onRename={() => setRename({ id: item.id, title: item.title })}
          onDelete={() => confirmDelete(item)}
          onCancel={() => confirmCancel(item)}
          onRetry={() => {
            invoke('documents:retry', { id: item.id }).catch(reportError)
          }}
        />
      </div>
    </div>
  )
}

function StatusIcon(props: { status: DocumentStatus }) {
  if (isActiveStatus(props.status)) return <Spinner size="sm" />
  if (props.status === 'failed') return <AlertTriangle size={18} className="text-danger" />
  if (props.status === 'completed') return <CheckCircle2 size={18} className="text-success" />
  if (props.status === 'cancelled') return <XCircle size={18} className="text-foreground/40" />
  return <FileText size={18} />
}

function RowMenu(props: {
  item: DocumentSummary
  platform: 'darwin' | 'win32' | undefined
  onRename: () => void
  onDelete: () => void
  onCancel: () => void
  onRetry: () => void
}) {
  const reveal = props.platform === 'win32' ? '在文件资源管理器中显示' : '在访达中显示'
  const completed = props.item.status === 'completed'
  const active = isActiveStatus(props.item.status)
  const retryable = props.item.status === 'failed' || props.item.status === 'cancelled'
  return (
    <Dropdown>
      {/* Dropdown.Trigger already renders a react-aria <button>; the icon goes in directly. */}
      <Dropdown.Trigger aria-label="更多" className="shrink-0 rounded-md p-1 text-foreground/70">
        <MoreHorizontal size={16} />
      </Dropdown.Trigger>
      <Dropdown.Popover>
        <Dropdown.Menu
          onAction={(key) => {
            if (key === 'open') {
              invoke('documents:openExternal', { id: props.item.id, kind: 'mono' }).catch(
                reportError,
              )
            }
            if (key === 'reveal') {
              invoke('documents:reveal', { id: props.item.id, kind: 'folder' }).catch(reportError)
            }
            if (key === 'retry') props.onRetry()
            if (key === 'cancel') props.onCancel()
            if (key === 'rename') props.onRename()
            if (key === 'delete') props.onDelete()
          }}
        >
          {completed ? (
            <Dropdown.Item id="open" textValue="用默认应用打开">
              用默认应用打开
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="reveal" textValue={reveal}>
            {reveal}
          </Dropdown.Item>
          <Separator />
          {retryable ? (
            <Dropdown.Item id="retry" textValue="重新处理">
              重新处理
            </Dropdown.Item>
          ) : null}
          {active ? (
            <Dropdown.Item id="cancel" textValue="取消处理…">
              取消处理…
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="rename" textValue="重命名…">
            重命名…
          </Dropdown.Item>
          <Dropdown.Item id="delete" textValue="删除…" variant="danger">
            删除…
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

export function RenameDialog() {
  const rename = useUiStore((s) => s.rename)
  if (!rename) return <RenameForm key="closed" id="" initial="" open={false} />
  return <RenameForm key={rename.id} id={rename.id} initial={rename.title} open />
}

function RenameForm(props: { id: string; initial: string; open: boolean }) {
  const setRename = useUiStore((s) => s.setRename)
  const [title, setTitle] = useState(props.initial)
  const [saving, setSaving] = useState(false)
  const state = useOverlayState({
    isOpen: props.open,
    onOpenChange: (open) => {
      if (!open && !saving) setRename(null)
    },
  })
  async function submit() {
    const trimmed = title.trim()
    if (!props.id || !trimmed || saving) return
    setSaving(true)
    try {
      await invoke('documents:rename', { id: props.id, title: trimmed })
      setRename(null)
    } catch (error) {
      notifyError(error)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal state={state}>
      <Modal.Backdrop isDismissable={!saving}>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>重命名</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <TextField value={title} onChange={setTitle} autoFocus>
                <Label>标题</Label>
                {/* 06 §6.2: the title is preselected so typing replaces it. */}
                <Input
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    // Enter that confirms an IME composition (Chinese input) is not a submit.
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void submit()
                    }
                  }}
                />
              </TextField>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" isDisabled={saving} onPress={() => setRename(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                isDisabled={!title.trim()}
                isPending={saving}
                onPress={() => {
                  void submit()
                }}
              >
                重命名
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

const confirmKeys = new WeakMap<ConfirmState, number>()
let nextConfirmKey = 0

function confirmKey(confirm: ConfirmState): number {
  let key = confirmKeys.get(confirm)
  if (key === undefined) {
    nextConfirmKey += 1
    key = nextConfirmKey
    confirmKeys.set(confirm, key)
  }
  return key
}

export function GlobalConfirm() {
  const confirm = useUiStore((s) => s.confirm)
  // Keep the last content while the dialog plays its exit animation, so the
  // title/body/buttons do not blank out (and the danger button keep its color).
  const [shown, setShown] = useState(confirm)
  if (confirm && confirm !== shown) setShown(confirm)
  const content = confirm ?? shown

  if (!content) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        body=""
        confirmLabel="确定"
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />
    )
  }
  return (
    <ConfirmDialog
      // A fresh dialog per confirm: nothing (pending state, content) leaks into the next one.
      key={confirmKey(content)}
      isOpen={confirm === content}
      title={content.title}
      body={content.body}
      confirmLabel={content.confirmLabel}
      {...(content.cancelLabel ? { cancelLabel: content.cancelLabel } : {})}
      {...(content.danger ? { danger: true } : {})}
      onOpenChange={(open) => {
        if (!open) useUiStore.getState().clearConfirm(content)
      }}
      onConfirm={async () => {
        await content.onConfirm()
        // Close only this confirm; one opened in the meantime stays.
        useUiStore.getState().clearConfirm(content)
      }}
    />
  )
}

export function DropOverlay(props: { visible: boolean }) {
  if (!props.visible) return null
  // The overlay takes the drag events itself: over the PDF preview they would otherwise go
  // to the iframe (Chromium's PDF viewer), and the drop would be lost.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
      data-testid="drop-overlay"
    >
      <div className="pointer-events-none flex flex-col items-center gap-3">
        <Upload size={48} />
        <p className="text-lg font-medium">松开以添加文档</p>
      </div>
    </div>
  )
}
