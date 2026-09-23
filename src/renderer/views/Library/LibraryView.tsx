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
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { formatBytes, formatRelativeTime } from '../../../shared/text'
import type { DocumentStatus, DocumentSummary } from '../../../shared/types'
import { invoke } from '../../api/invoke'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useDocumentsStore } from '../../store/documents'
import { useSettingsStore } from '../../store/settings'
import { useUiStore } from '../../store/ui'
import { progressLabel, stageName } from '../../lib/labels'

const ROW_HEIGHT = 88

export function LibraryView() {
  const itemsMap = useDocumentsStore((s) => s.items)
  const counts = useDocumentsStore((s) => s.counts)
  const filter = useDocumentsStore((s) => s.filter)
  const query = useDocumentsStore((s) => s.query)
  const selectedId = useDocumentsStore((s) => s.selectedId)
  const setFilter = useDocumentsStore((s) => s.setFilter)
  const select = useDocumentsStore((s) => s.select)
  const llmReady = useSettingsStore((s) => s.view?.capabilities.llmReady ?? false)
  const openNew = useUiStore((s) => s.openNewTranslation)
  const setView = useUiStore((s) => s.setView)
  const setSettingsTab = useUiStore((s) => s.setSettingsTab)
  const platform = useUiStore((s) => s.appInfo?.platform)
  const items = useMemo(
    () => [...itemsMap.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [itemsMap],
  )

  const empty = counts.all === 0 && !query
  const filteredEmpty = items.length === 0 && !empty

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-divider">
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
          <Button
            variant="ghost"
            className="w-full justify-start"
            onPress={() => {
              setSettingsTab('general')
              setView('settings')
            }}
          >
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
            onAddProvider={() => {
              setSettingsTab('providers')
              setView('settings')
            }}
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
            platform={platform}
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

function DocumentList(props: {
  items: DocumentSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  platform: 'darwin' | 'win32' | undefined
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 40 })
  const virtual = props.items.length > 200

  useEffect(() => {
    const el = scroller.current
    if (!el || !virtual) return
    const onScroll = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - 20)
      const end = Math.min(props.items.length, start + Math.ceil(el.clientHeight / ROW_HEIGHT) + 40)
      setRange({ start, end })
    }
    onScroll()
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [props.items.length, virtual])

  const slice = virtual ? props.items.slice(range.start, range.end) : props.items
  const padTop = virtual ? range.start * ROW_HEIGHT : 0
  const padBottom = virtual ? Math.max(0, (props.items.length - range.end) * ROW_HEIGHT) : 0

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-auto"
      role="listbox"
      aria-label="文档列表"
    >
      <div style={{ height: padTop }} />
      {slice.map((item) => (
        <DocumentRow
          key={item.id}
          item={item}
          selected={item.id === props.selectedId}
          platform={props.platform}
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
  onSelect: () => void
}) {
  const { item } = props
  const setRename = useUiStore((s) => s.setRename)
  const setConfirm = useUiStore((s) => s.setConfirm)
  const subtitle = [
    item.translator.label,
    formatBytes(item.sourceSize),
    item.pages != null ? `${item.pages} 页` : null,
    formatRelativeTime(item.updatedAt),
  ]
    .filter(Boolean)
    .join(' · ')
  const active =
    item.status === 'queued' || item.status === 'processing' || item.status === 'retrying'

  return (
    <div
      role="option"
      aria-selected={props.selected}
      data-testid={`document-row-${item.id}`}
      data-status={item.status}
      className={clsx(
        'flex cursor-default items-start gap-3 border-b border-divider px-3 py-2',
        props.selected && 'bg-accent/10',
      )}
      onClick={props.onSelect}
      onDoubleClick={() => {
        if (item.status === 'completed') {
          void invoke('documents:openExternal', { id: item.id, kind: 'mono' })
        }
      }}
    >
      <StatusIcon status={item.status} />
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
        onDelete={() =>
          setConfirm({
            title: `删除“${item.title}”？`,
            body: '译文、PDF、处理记录和文档库里的源文件副本都会被删除，你最初选择的文件不受影响。此操作无法撤销。',
            confirmLabel: '删除',
            danger: true,
            onConfirm: async () => {
              await invoke('documents:delete', { ids: [item.id] })
              useUiStore.getState().setConfirm(null)
            },
          })
        }
        onCancel={() =>
          setConfirm({
            title: `取消处理“${item.title}”？`,
            body: '正在进行的解析、翻译或排版会停止。源文件和已完成的翻译断点会保留，之后可以重新处理。',
            confirmLabel: '取消处理',
            cancelLabel: '继续处理',
            danger: true,
            onConfirm: async () => {
              await invoke('documents:cancel', { id: item.id })
              useUiStore.getState().setConfirm(null)
            },
          })
        }
        onRetry={() => {
          void invoke('documents:retry', { id: item.id })
        }}
      />
    </div>
  )
}

function StatusIcon(props: { status: DocumentStatus }) {
  if (props.status === 'processing' || props.status === 'queued' || props.status === 'retrying') {
    return <Spinner size="sm" />
  }
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
  const active =
    props.item.status === 'queued' ||
    props.item.status === 'processing' ||
    props.item.status === 'retrying'
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
            if (key === 'open')
              void invoke('documents:openExternal', { id: props.item.id, kind: 'mono' })
            if (key === 'reveal')
              void invoke('documents:reveal', { id: props.item.id, kind: 'folder' })
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
  const state = useOverlayState({
    isOpen: props.open,
    onOpenChange: (open) => {
      if (!open) setRename(null)
    },
  })
  return (
    <Modal state={state}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>重命名</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <TextField value={title} onChange={setTitle} autoFocus>
                <Label>标题</Label>
                <Input />
              </TextField>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" onPress={() => setRename(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                isDisabled={!title.trim()}
                onPress={() => {
                  if (!props.id || !title.trim()) return
                  void invoke('documents:rename', { id: props.id, title: title.trim() }).then(() =>
                    setRename(null),
                  )
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
      isOpen={confirm !== null}
      title={content.title}
      body={content.body}
      confirmLabel={content.confirmLabel}
      {...(content.cancelLabel ? { cancelLabel: content.cancelLabel } : {})}
      {...(content.danger ? { danger: true } : {})}
      onOpenChange={(open) => {
        if (!open) useUiStore.getState().setConfirm(null)
      }}
      onConfirm={() => {
        if (confirm) return confirm.onConfirm()
      }}
    />
  )
}

export function DropOverlay(props: { visible: boolean }) {
  if (!props.visible) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80">
      <div className="flex flex-col items-center gap-3">
        <Upload size={48} />
        <p className="text-lg font-medium">松开以添加文档</p>
      </div>
    </div>
  )
}
