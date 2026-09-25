import {
  Alert,
  Button,
  ButtonGroup,
  Chip,
  Drawer,
  Dropdown,
  ProgressBar,
  Separator,
  Spinner,
  Switch,
  Tabs,
  Tooltip,
  useOverlayState,
} from '@heroui/react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Info,
  XCircle,
  XOctagon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ERROR_CODES } from '../../../shared/errors'
import { isActiveStatus } from '../../../shared/library-filter'
import { formatBytes } from '../../../shared/text'
import type { DocumentSummary, ProcessingEvent } from '../../../shared/types'
import { toDocflowError } from '../../api/errors'
import { invoke } from '../../api/invoke'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import {
  STATUS_COLOR,
  STATUS_LABEL,
  STAGES,
  basename,
  formatClock,
  formatElapsed,
  stageName,
} from '../../lib/labels'
import { notify, notifyError } from '../../lib/notify'
import { useDocumentsStore } from '../../store/documents'
import { useUiStore } from '../../store/ui'
import { confirmCancel, confirmDelete, useDeletingStore } from './actions'
import { elapsedMs, latestEvent, stageState, type StageState } from './progress'

type ExportKind = 'mono' | 'dual' | 'glossary' | 'source' | 'bundle'

// Stable fallback: zustand 5 selectors must not return a fresh array on every call,
// otherwise useSyncExternalStore loops forever ("Maximum update depth exceeded").
const NO_EVENTS: ProcessingEvent[] = []

/** 06 §6.4: fall back to the default app when the embedded viewer has not loaded by then. */
const PREVIEW_TIMEOUT_MS = 5_000

/** Fire-and-forget IPC from a button: a user-facing failure becomes a toast. */
function fire(request: Promise<unknown>): void {
  request.catch((error: unknown) => notifyError(error))
}

// `overlay` is set when the detail is rendered inside the narrow-window Drawer (App.tsx).
export function DocumentDetail(props: { overlay?: boolean }) {
  const selectedId = useDocumentsStore((s) => s.selectedId)
  const item = useDocumentsStore((s) => (selectedId ? s.items.get(selectedId) : undefined))
  const events = useDocumentsStore((s) =>
    selectedId ? (s.events.get(selectedId) ?? NO_EVENTS) : NO_EVENTS,
  )
  const deleting = useDeletingStore((s) => (selectedId ? s.ids.has(selectedId) : false))
  const infoOpen = useUiStore((s) => s.infoOpen)
  const setInfoOpen = useUiStore((s) => s.setInfoOpen)
  const setRename = useUiStore((s) => s.setRename)
  const platform = useUiStore((s) => s.appInfo?.platform)
  const [userTab, setUserTab] = useState<string | null>(null)
  const [warningsOnly, setWarningsOnly] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [exportError, setExportError] = useState<string | null>(null)
  // Only unfinished documents have a running clock (elapsed time, retry countdown).
  const ticking = item ? isActiveStatus(item.status) : false

  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])

  // Processing records are loaded once per document; pushed events are merged by the store.
  useEffect(() => {
    if (!selectedId) return
    useDocumentsStore
      .getState()
      .ensureEvents(selectedId)
      .catch((error: unknown) => {
        // A document deleted in the meantime simply has no records to show.
        if (toDocflowError(error).code !== ERROR_CODES.not_found) notifyError(error)
      })
  }, [selectedId])

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-foreground/50">
        选择一篇文档查看详情
      </div>
    )
  }

  const completed = item.status === 'completed'
  // Only a bilingual PDF that was actually written gets a tab (the setting may have been off).
  const showDual = Boolean(item.files.dual)
  const reveal = platform === 'win32' ? '在文件资源管理器中显示' : '在访达中显示'
  const tabKeys = completed
    ? showDual
      ? ['mono', 'dual', 'events']
      : ['mono', 'events']
    : ['events']
  // A controlled selectedKey that is missing from the tab list leaves React Aria with no
  // selected tab (and no panel), e.g. when the selected PDF tab disappears.
  const tab = userTab && tabKeys.includes(userTab) ? userTab : completed ? 'mono' : 'events'

  return (
    <div className="flex h-full min-w-0 flex-col" data-overlay={props.overlay ? 'true' : undefined}>
      <header className="flex items-start gap-3 border-b border-separator px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-base font-medium"
            title={item.title}
            onDoubleClick={() => setRename({ id: item.id, title: item.title })}
          >
            {item.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/70">
            <Chip size="sm" color={STATUS_COLOR[item.status]}>
              {STATUS_LABEL[item.status]}
            </Chip>
            <span>
              {item.translator.label}
              {item.pages != null ? ` · ${item.pages} 页` : ''} · {formatBytes(item.sourceSize)}
            </span>
          </div>
        </div>
        <HeaderActions
          item={item}
          reveal={reveal}
          onExportError={setExportError}
          onRename={() => setRename({ id: item.id, title: item.title })}
        />
        <Button isIconOnly variant="ghost" aria-label="文档信息" onPress={() => setInfoOpen(true)}>
          <Info size={16} />
        </Button>
      </header>
      {!completed ? <ProcessingPanel item={item} events={events} now={now} /> : null}
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => {
          if (typeof key === 'string') setUserTab(key)
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="文档详情">
            {completed ? (
              <Tabs.Tab id="mono">
                中文 PDF
                <Tabs.Indicator />
              </Tabs.Tab>
            ) : null}
            {completed && showDual ? (
              <Tabs.Tab id="dual">
                双语对照
                <Tabs.Indicator />
              </Tabs.Tab>
            ) : null}
            <Tabs.Tab id="events">
              处理记录
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        {completed ? (
          <Tabs.Panel id="mono" className="min-h-0 flex-1">
            <PdfPreview
              src={item.files.mono}
              title="中文 PDF"
              unloaded={deleting}
              onOpen={() => fire(invoke('documents:openExternal', { id: item.id, kind: 'mono' }))}
            />
          </Tabs.Panel>
        ) : null}
        {completed && showDual ? (
          <Tabs.Panel id="dual" className="min-h-0 flex-1">
            <PdfPreview
              src={item.files.dual}
              title="双语对照 PDF"
              unloaded={deleting}
              onOpen={() => fire(invoke('documents:openExternal', { id: item.id, kind: 'dual' }))}
            />
          </Tabs.Panel>
        ) : null}
        <Tabs.Panel id="events" className="min-h-0 flex-1 overflow-auto p-3">
          <EventList events={events} warningsOnly={warningsOnly} onToggle={setWarningsOnly} />
        </Tabs.Panel>
      </Tabs>
      <InfoDrawer
        item={item}
        now={now}
        isOpen={infoOpen}
        onOpenChange={setInfoOpen}
        reveal={reveal}
      />
      <ConfirmDialog
        isOpen={Boolean(exportError)}
        title="导出失败"
        body={exportError ?? ''}
        confirmLabel="确定"
        onOpenChange={(open) => {
          if (!open) setExportError(null)
        }}
        onConfirm={() => setExportError(null)}
      />
    </div>
  )
}

function exportName(item: DocumentSummary, kind: ExportKind): string {
  if (kind === 'mono') return item.suggestedNames.mono
  if (kind === 'dual') return item.suggestedNames.dual
  if (kind === 'bundle') return item.suggestedNames.bundle
  if (kind === 'glossary') return item.suggestedNames.glossary
  return item.suggestedNames.source
}

function HeaderActions(props: {
  item: DocumentSummary
  reveal: string
  onExportError: (message: string) => void
  onRename: () => void
}) {
  const { item } = props
  const completed = item.status === 'completed'
  const active = isActiveStatus(item.status)
  // 05 §5.7: only failed or cancelled documents can be processed again.
  const retryable = item.status === 'failed' || item.status === 'cancelled'

  async function exportKind(kind: ExportKind) {
    const result = await invoke('documents:export', { id: item.id, kind })
    if (!('path' in result)) return
    // Name and folder of the file the user actually saved, not the library copy.
    const path = result.path
    notify.success(`已导出“${basename(path)}”`, {
      timeout: 8000,
      actionProps: {
        children: '打开所在文件夹',
        onPress: () => fire(invoke('shell:revealExport', { path })),
      },
    })
  }

  return (
    <ButtonGroup>
      {completed ? (
        <Button
          variant="secondary"
          onPress={() => fire(invoke('documents:openExternal', { id: item.id, kind: 'mono' }))}
        >
          <ExternalLink size={14} />
          打开
        </Button>
      ) : null}
      {completed ? (
        // Dropdown.Trigger already renders a <button>; the pressable Button goes directly
        // inside Dropdown (MenuTrigger) instead, avoiding <button> inside <button>.
        <Dropdown>
          <Button variant="secondary">导出</Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              onAction={(key) => {
                const kind = key as ExportKind
                exportKind(kind).catch((error: unknown) => {
                  const err = toDocflowError(error)
                  // invoke() already toasted an internal error; show it only once.
                  if (err.user)
                    props.onExportError(`“${exportName(item, kind)}”没有导出：${err.message}`)
                })
              }}
            >
              <Dropdown.Item id="mono" textValue="中文 PDF…">
                中文 PDF…
              </Dropdown.Item>
              {item.files.dual ? (
                <Dropdown.Item id="dual" textValue="双语对照 PDF…">
                  双语对照 PDF…
                </Dropdown.Item>
              ) : null}
              {item.files.glossary ? (
                <Dropdown.Item id="glossary" textValue="术语表（CSV）…">
                  术语表（CSV）…
                </Dropdown.Item>
              ) : null}
              <Dropdown.Item id="source" textValue="源文件…">
                源文件…
              </Dropdown.Item>
              <Separator />
              <Dropdown.Item id="bundle" textValue="全部文件（ZIP）…">
                全部文件（ZIP）…
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      {active ? (
        <Button variant="danger" onPress={() => confirmCancel(item)}>
          取消处理…
        </Button>
      ) : null}
      {retryable ? (
        <Button variant="primary" onPress={() => fire(invoke('documents:retry', { id: item.id }))}>
          重新处理
        </Button>
      ) : null}
      {/* No aria-label here: the visible text names the button, and the library row menu
          button owns the "更多" label (getByLabel is a substring match, so any label containing
          "更多" would make that locator ambiguous). */}
      <Dropdown>
        <Button variant="ghost">更多</Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            onAction={(key) => {
              if (key === 'reveal')
                fire(invoke('documents:reveal', { id: item.id, kind: 'folder' }))
              if (key === 'rename') props.onRename()
              if (key === 'delete') confirmDelete(item)
            }}
          >
            <Dropdown.Item id="reveal" textValue={props.reveal}>
              {props.reveal}
            </Dropdown.Item>
            <Dropdown.Item id="rename" textValue="重命名…">
              重命名…
            </Dropdown.Item>
            {!active ? (
              <Dropdown.Item id="delete" textValue="删除…" variant="danger">
                删除…
              </Dropdown.Item>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </ButtonGroup>
  )
}

function PdfPreview(props: {
  src: string | undefined
  title: string
  /** The document is being deleted: keep the viewer off its files. */
  unloaded: boolean
  onOpen: () => void
}) {
  const { src, unloaded } = props
  // Load and failure are remembered per src, so each preview (and each new file) gets its own try.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const waiting = Boolean(src) && !unloaded && loadedSrc !== src && failedSrc !== src
  useEffect(() => {
    if (!waiting || !src) return
    const timer = setTimeout(() => setFailedSrc(src), PREVIEW_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [waiting, src])
  if (unloaded) {
    return <iframe className="h-full w-full border-0" src="about:blank" title={props.title} />
  }
  if (!src || failedSrc === src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
        <p>无法在应用内预览，请用默认应用打开。</p>
        <Button onPress={props.onOpen}>用默认应用打开</Button>
      </div>
    )
  }
  return (
    <iframe
      className="h-full w-full border-0"
      src={`${src}#toolbar=1&navpanes=0`}
      title={props.title}
      onLoad={() => setLoadedSrc(src)}
      onError={() => setFailedSrc(src)}
    />
  )
}

function ProcessingPanel(props: { item: DocumentSummary; events: ProcessingEvent[]; now: number }) {
  const { item } = props
  const latest = latestEvent(props.events)
  const elapsed = formatElapsed(elapsedMs(item, props.now, { fromCreated: true }) ?? 0)
  const retryLeft =
    item.status === 'retrying' && item.nextAttemptAt
      ? Math.max(0, Math.ceil((Date.parse(item.nextAttemptAt) - props.now) / 1000))
      : 0
  return (
    <div className="grid gap-3 border-b border-separator p-3 md:grid-cols-2">
      <div className="rounded-lg border border-separator p-3">
        <p className="mb-2 text-sm font-medium">处理进度</p>
        <ProgressBar
          value={item.progress}
          minValue={0}
          maxValue={100}
          isIndeterminate={item.progress <= 3}
          aria-label="处理进度"
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
        <p className="mt-2 text-sm">
          {Math.round(item.progress)}% · {stageName(item.stage)}
          {latest ? ` · ${latest.message}` : ''} · 已用时 {elapsed}
        </p>
        {item.status === 'failed' ? (
          <Alert status="danger" className="mt-3">
            <Alert.Content>
              <Alert.Title>处理失败</Alert.Title>
              <Alert.Description>{item.failure?.message}</Alert.Description>
              <Button size="sm" onPress={() => fire(invoke('documents:retry', { id: item.id }))}>
                重新处理
              </Button>
            </Alert.Content>
          </Alert>
        ) : null}
        {item.status === 'cancelled' ? (
          <Alert status="danger" className="mt-3">
            <Alert.Content>
              <Alert.Title>已取消处理</Alert.Title>
              <Alert.Description>{item.failure?.message}</Alert.Description>
              <Button size="sm" onPress={() => fire(invoke('documents:retry', { id: item.id }))}>
                重新处理
              </Button>
            </Alert.Content>
          </Alert>
        ) : null}
        {item.status === 'retrying' ? (
          <Alert status="warning" className="mt-3">
            <Alert.Content>
              <Alert.Title>
                等待自动重试（第 {item.attempts} 次），{retryLeft} 秒后开始
              </Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}
      </div>
      <div className="rounded-lg border border-separator p-3">
        <p className="mb-2 text-sm font-medium">处理阶段</p>
        <ul className="space-y-2 text-sm">
          {STAGES.map((stage) => (
            <li key={stage.id} className="flex items-start gap-2">
              <StageIcon state={stageState(item, stage.id)} />
              <div>
                <div className="font-medium">{stage.name}</div>
                <div className="text-xs text-foreground/60">
                  {stage.id === 'translate' ? item.translator.label : stage.detail}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function StageIcon(props: { state: StageState }) {
  switch (props.state) {
    case 'done':
      return <CheckCircle2 size={16} className="shrink-0 text-success" />
    case 'running':
      return <Spinner size="sm" />
    case 'failed':
      return <XOctagon size={16} className="shrink-0 text-danger" />
    case 'cancelled':
      return <XCircle size={16} className="shrink-0 text-foreground/50" />
    case 'waiting':
      return <Circle size={16} className="shrink-0 text-foreground/30" />
  }
}

function EventList(props: {
  events: ProcessingEvent[]
  warningsOnly: boolean
  onToggle: (value: boolean) => void
}) {
  const sorted = useMemo(() => [...props.events].sort((a, b) => b.seq - a.seq), [props.events])
  const filtered = props.warningsOnly
    ? sorted.filter((item) => item.level === 'warning' || item.level === 'error')
    : sorted
  const limited = filtered.slice(0, 1000)
  // `+elapsed` counts from the oldest record (sorted is newest first).
  const first = sorted.at(-1)
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium">处理记录 · {filtered.length} 条</p>
        {/* HeroUI 3.2: Switch.Content is the clickable SwitchButton, so Control nests inside it. */}
        <Switch isSelected={props.warningsOnly} onChange={props.onToggle}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            只看警告和错误
          </Switch.Content>
        </Switch>
      </div>
      {filtered.length > 1000 ? (
        <p className="mb-2 text-xs text-foreground/60">只显示最近 1000 条</p>
      ) : null}
      {limited.length === 0 ? (
        <p className="text-sm text-foreground/60">
          {props.warningsOnly ? '没有警告或错误。' : '暂无记录。'}
        </p>
      ) : (
        <ul className="space-y-2">
          {limited.map((event) => (
            <li key={event.seq} className="flex items-start gap-2 text-sm">
              <LevelIcon level={event.level} />
              <div className="min-w-0 flex-1">
                <div>{event.message}</div>
                {event.detail ? (
                  <div className="selectable text-xs text-foreground/60">{event.detail}</div>
                ) : null}
              </div>
              <div className="shrink-0 text-right text-xs text-foreground/50">
                <div>{formatClock(event.at)}</div>
                {first ? (
                  <div>+{formatElapsed(Date.parse(event.at) - Date.parse(first.at))}</div>
                ) : null}
                {event.progress != null ? <div>{Math.round(event.progress)}%</div> : null}
                {event.current != null && event.total != null ? (
                  <div>
                    {event.current}/{event.total}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LevelIcon(props: { level: ProcessingEvent['level'] }) {
  if (props.level === 'success') return <CheckCircle2 size={16} className="text-success" />
  if (props.level === 'warning') return <AlertTriangle size={16} className="text-warning" />
  if (props.level === 'error') return <XCircle size={16} className="text-danger" />
  return <Info size={16} className="text-foreground/40" />
}

function InfoDrawer(props: {
  item: DocumentSummary
  now: number
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  reveal: string
}) {
  const state = useOverlayState({ isOpen: props.isOpen, onOpenChange: props.onOpenChange })
  const { item } = props
  const elapsed = elapsedMs(item, props.now)
  return (
    <Drawer state={state}>
      <Drawer.Backdrop isDismissable>
        {/* Width goes on the panel (Dialog); Content is the full-window positioning layer. */}
        <Drawer.Content placement="right">
          <Drawer.Dialog className="w-[360px]">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading>文档信息</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="space-y-4 text-sm">
              <section>
                <h3 className="mb-1 font-medium">文档</h3>
                <p>状态：{STATUS_LABEL[item.status]}</p>
                <p>翻译服务：{item.translator.label}</p>
                <p>页数：{item.pages ?? '—'}</p>
                <p>
                  段落数：
                  {item.stats
                    ? `已翻译 ${item.stats.translated} / 待翻译 ${item.stats.translatable}，保留原文 ${item.stats.kept}`
                    : '—'}
                </p>
                <p>
                  用量 tokens：
                  {item.stats ? `${item.stats.usage.input} / ${item.stats.usage.output}` : '—'}
                </p>
              </section>
              <section>
                <h3 className="mb-1 font-medium">源文件</h3>
                <p className="selectable" title={item.originalFilename}>
                  {item.originalFilename}
                </p>
                <p>{formatBytes(item.sourceSize)}</p>
                <Tooltip>
                  <Tooltip.Trigger>
                    <span className="selectable">{item.sourceSha256.slice(0, 16)}</span>
                  </Tooltip.Trigger>
                  <Tooltip.Content>{item.sourceSha256}</Tooltip.Content>
                </Tooltip>
              </section>
              <section>
                <h3 className="mb-1 font-medium">时间</h3>
                <p>加入：{new Date(item.createdAt).toLocaleString()}</p>
                <p>开始：{item.startedAt ? new Date(item.startedAt).toLocaleString() : '—'}</p>
                <p>完成：{item.completedAt ? new Date(item.completedAt).toLocaleString() : '—'}</p>
                <p>用时：{elapsed === null ? '—' : formatElapsed(elapsed)}</p>
              </section>
            </Drawer.Body>
            <Drawer.Footer>
              <Button
                variant="secondary"
                onPress={() => fire(invoke('documents:reveal', { id: item.id, kind: 'folder' }))}
              >
                {props.reveal}
              </Button>
              <Button
                isDisabled={!item.files.mono}
                onPress={() =>
                  fire(invoke('documents:openExternal', { id: item.id, kind: 'mono' }))
                }
              >
                用默认应用打开
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  )
}
