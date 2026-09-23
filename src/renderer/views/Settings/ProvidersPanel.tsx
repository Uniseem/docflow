import {
  Button,
  Card,
  CloseButton,
  Description,
  Dropdown,
  FieldError,
  Header,
  Input,
  Label,
  ListBox,
  Modal,
  SearchField,
  Select,
  Switch,
  TextArea,
  TextField,
  Tooltip,
} from '@heroui/react'
import { Minus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { z } from 'zod'
import { EXTRA_BODY_FORBIDDEN, MAX_MODELS_PER_PROVIDER } from '../../../shared/constants'
import { chatUrl } from '../../../shared/provider-url'
import { uniqueProviderId } from '../../../shared/presets'
import {
  HttpUrl,
  ModelConfig,
  PROVIDER_TYPE_LABELS,
  ProviderConfig,
  type ProviderType,
} from '../../../shared/types'
import type { ModelInfo } from '../../../shared/types'
import type { SettingsView, SettingsViewProvider } from '../../../shared/view'
import { toDocflowError } from '../../api/errors'
import { invoke } from '../../api/invoke'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { notify, notifyError } from '../../lib/notify'
import { useSettingsStore } from '../../store/settings'

const GROUP_LABEL: Record<string, string> = {
  domestic: '国内服务',
  international: '国际服务',
  local: '本机模型',
}

const NAME_MAX = 64
const NAME_REQUIRED = '请填写名称'
const NAME_TOO_LONG = `名称不能超过 ${NAME_MAX} 个字符`
const BASE_URL_INVALID = '请填写以 http:// 或 https:// 开头的完整地址'

function nameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return NAME_REQUIRED
  if (trimmed.length > NAME_MAX) return NAME_TOO_LONG
  return null
}

function baseUrlProblem(baseUrl: string): string | null {
  return HttpUrl.safeParse(baseUrl).success ? null : BASE_URL_INVALID
}

/** Chinese reason for the first issue of a rejected ProviderConfig. */
function providerIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  const field = issue?.path[0]
  if (field === 'name') return NAME_TOO_LONG
  if (field === 'baseUrl') return `API 地址无效：${BASE_URL_INVALID}`
  if (field === 'extraBody') return '附加请求参数不能覆盖 model、messages 等字段'
  if (field === 'concurrency') return '并发请求数需在 1–2000 之间'
  if (field === 'models') {
    return issue?.code === 'too_big'
      ? `模型不能超过 ${MAX_MODELS_PER_PROVIDER} 个`
      : '模型 ID 重复或无效'
  }
  return '输入无效'
}

/** The saved config of a provider, freshest first (the store may be ahead of props). */
function savedProvider(fallback: SettingsViewProvider): SettingsViewProvider {
  return (
    useSettingsStore.getState().view?.providers.find((item) => item.id === fallback.id) ?? fallback
  )
}

export function ProvidersPanel() {
  const view = useSettingsStore((s) => s.view)
  const selectedId = useSettingsStore((s) => s.selectedProviderId)
  const select = useSettingsStore((s) => s.selectProvider)
  const apply = useSettingsStore((s) => s.apply)
  const [customOpen, setCustomOpen] = useState(false)
  // Remounts the modal on every open so it never shows the previous input.
  const [customKey, setCustomKey] = useState(0)
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (!view) return null
  const selected = view.providers.find((item) => item.id === selectedId) ?? null

  async function addPreset(presetId: string) {
    const snapshot = useSettingsStore.getState().view
    if (!snapshot) return
    const preset = snapshot.presets.find((item) => item.id === presetId)
    if (!preset) return
    const id = uniqueProviderId(
      preset.id,
      snapshot.providers.map((item) => item.id),
    )
    const parsed = ProviderConfig.safeParse({
      id,
      name: preset.name,
      type: preset.type,
      baseUrl: preset.baseUrl || 'http://127.0.0.1:11434/v1',
      enabled: true,
      models: [],
      concurrency: 100,
      preset: preset.id,
    })
    if (!parsed.success) {
      notify.danger(`设置未保存：${providerIssueMessage(parsed.error)}`)
      return
    }
    try {
      const next = (await invoke('providers:save', { provider: parsed.data })) as SettingsView
      apply(next)
      select(id)
    } catch (error) {
      notifyError(error, '设置未保存：')
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[240px] shrink-0 flex-col border-r border-separator">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <p className="text-sm font-medium">大模型服务商</p>
          <div data-testid="add-provider">
            <Dropdown>
              {/* Dropdown.Trigger already renders a react-aria <Button>; nesting another
                  <button> inside it is invalid DOM, so the text goes in directly. */}
              <Dropdown.Trigger className="text-sm text-accent">添加服务商</Dropdown.Trigger>
              <Dropdown.Popover>
                <Dropdown.Menu
                  onAction={(key) => {
                    if (key === 'custom') {
                      setCustomKey((current) => current + 1)
                      setCustomOpen(true)
                    } else void addPreset(String(key))
                  }}
                >
                  {(['domestic', 'international', 'local'] as const).map((group) => (
                    <Dropdown.Section key={group}>
                      <Header>{GROUP_LABEL[group]}</Header>
                      {view.presets
                        .filter((preset) => preset.group === group)
                        .map((preset) => (
                          <Dropdown.Item key={preset.id} id={preset.id} textValue={preset.name}>
                            <span data-testid={`preset-${preset.id}`}>{preset.name}</span>
                          </Dropdown.Item>
                        ))}
                    </Dropdown.Section>
                  ))}
                  <Dropdown.Item id="custom" textValue="自定义服务商…">
                    自定义服务商…
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>
        </div>
        <ListBox
          aria-label="大模型服务商"
          selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
          selectionMode="single"
          onSelectionChange={(keys) => {
            const key = [...keys][0]
            if (typeof key === 'string') select(key)
          }}
          className="min-h-0 flex-1 overflow-auto px-1"
        >
          {view.providers.map((provider) => (
            <ListBox.Item
              key={provider.id}
              id={provider.id}
              textValue={provider.name}
              // HeroUI 3 does not style the selected list-box item by itself.
              className="data-[selected=true]:bg-accent-soft"
            >
              <div className="flex flex-col">
                <span>{provider.name}</span>
                <span className="text-xs text-foreground/60">{providerStatus(provider)}</span>
              </div>
            </ListBox.Item>
          ))}
        </ListBox>
        <div className="flex gap-1 border-t border-separator p-2">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="删除服务商"
            isDisabled={!selected}
            onPress={() => setDeleteOpen(true)}
          >
            <Minus size={16} />
          </Button>
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
        {selected ? (
          <ProviderDetail key={selected.id} provider={selected} />
        ) : (
          <p className="text-sm text-foreground/60">添加一个服务商以开始翻译。</p>
        )}
      </div>
      <CustomProviderModal key={customKey} isOpen={customOpen} onOpenChange={setCustomOpen} />
      <ConfirmDialog
        isOpen={deleteOpen}
        title={`删除“${selected?.name ?? ''}”？`}
        body="服务商的设置和保存在本机的 API Key 会被删除。已经完成的文档不受影响；使用它排队中的文档将无法继续翻译。"
        confirmLabel="删除"
        danger
        onOpenChange={setDeleteOpen}
        onConfirm={async () => {
          if (!selected) return
          const next = (await invoke('providers:delete', { id: selected.id })) as SettingsView
          apply(next)
          setDeleteOpen(false)
        }}
      />
    </div>
  )
}

function providerStatus(provider: SettingsViewProvider): string {
  if (!provider.enabled) return '已停用'
  if (provider.models.length === 0) return '需要添加模型'
  if (!provider.keyConfigured && !provider.keyOptional) return '需要 API Key'
  return `${provider.models.length} 个模型`
}

type ProviderPatch = Partial<
  Pick<ProviderConfig, 'name' | 'baseUrl' | 'enabled' | 'models' | 'concurrency' | 'extraBody'>
>

function ProviderDetail(props: { provider: SettingsViewProvider }) {
  const apply = useSettingsStore((s) => s.apply)
  const update = useSettingsStore((s) => s.update)
  const [name, setName] = useState(props.provider.name)
  const [nameError, setNameError] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState(props.provider.baseUrl)
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [extra, setExtra] = useState(
    props.provider.extraBody ? JSON.stringify(props.provider.extraBody, null, 2) : '',
  )
  const [extraError, setExtraError] = useState<string | null>(null)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [addModelKey, setAddModelKey] = useState(0)
  const [pickOpen, setPickOpen] = useState(false)
  const [remoteModels, setRemoteModels] = useState<ModelInfo[]>([])
  const [listing, setListing] = useState(false)
  const [checks, setChecks] = useState<Record<string, string>>({})
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * Saves `patch` on top of the saved config. Unsaved drafts of other fields are never sent,
   * so one invalid input cannot make later saves fail. Resolves false (after a toast) on error.
   */
  async function savePatch(patch: ProviderPatch): Promise<boolean> {
    const saved = savedProvider(props.provider)
    const extraBody = 'extraBody' in patch ? patch.extraBody : saved.extraBody
    const parsed = ProviderConfig.safeParse({
      id: saved.id,
      name: patch.name ?? saved.name,
      type: saved.type,
      baseUrl: patch.baseUrl ?? saved.baseUrl,
      enabled: patch.enabled ?? saved.enabled,
      models: patch.models ?? saved.models,
      concurrency: patch.concurrency ?? saved.concurrency,
      ...(saved.preset ? { preset: saved.preset } : {}),
      ...(extraBody ? { extraBody } : {}),
    })
    if (!parsed.success) {
      notify.danger(`设置未保存：${providerIssueMessage(parsed.error)}`)
      return false
    }
    try {
      const viewNext = (await invoke('providers:save', { provider: parsed.data })) as SettingsView
      apply(viewNext)
      const firstModel = patch.models?.[0]
      if (firstModel && !viewNext.defaultTranslator) {
        await update({ defaultTranslator: { providerId: saved.id, model: firstModel.id } })
      }
      return true
    } catch (error) {
      notifyError(error, '设置未保存：')
      return false
    }
  }

  /** Validates the API address draft; shows the field error and returns null when invalid. */
  function validBaseUrl(): string | null {
    const problem = baseUrlProblem(baseUrl)
    setBaseUrlError(problem)
    return problem ? null : HttpUrl.parse(baseUrl)
  }

  async function saveKey(value: string | null) {
    try {
      const next = (await invoke('secrets:set', {
        providerId: props.provider.id,
        value,
      })) as SettingsView
      apply(next)
      if (value !== null) setKeyDraft('')
    } catch (error) {
      notifyError(error)
    }
  }

  async function checkModel(modelId: string) {
    const url = validBaseUrl()
    if (!url) return
    setChecking((current) => new Set(current).add(modelId))
    try {
      const result = await invoke('providers:check', {
        providerId: props.provider.id,
        type: props.provider.type,
        baseUrl: url,
        ...(keyDraft.trim() ? { key: keyDraft.trim() } : {}),
        model: modelId,
      })
      setChecks((current) => ({
        ...current,
        [modelId]: result.ok ? `可用 · ${result.latencyMs} ms · “${result.reply}”` : result.message,
      }))
    } catch (error) {
      // Internal errors were toasted by invoke(); user-facing ones are shown in place.
      const err = toDocflowError(error)
      if (err.user) setChecks((current) => ({ ...current, [modelId]: err.message }))
    } finally {
      setChecking((current) => {
        const next = new Set(current)
        next.delete(modelId)
        return next
      })
    }
  }

  async function fetchModels() {
    const url = validBaseUrl()
    if (!url) return
    setListing(true)
    try {
      const result = await invoke('providers:listModels', {
        providerId: props.provider.id,
        type: props.provider.type,
        baseUrl: url,
        ...(keyDraft.trim() ? { key: keyDraft.trim() } : {}),
      })
      if (result.models.length === 0) {
        notify.info('服务商没有返回任何模型，请手动添加模型 ID。')
        return
      }
      setRemoteModels(result.models)
      setPickOpen(true)
    } catch (error) {
      notifyError(error)
    } finally {
      setListing(false)
    }
  }

  function applyExtra() {
    if (!extra.trim()) {
      setExtraError(null)
      void savePatch({ extraBody: undefined })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(extra)
    } catch {
      setExtraError('不是有效的 JSON')
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setExtraError('不是有效的 JSON')
      return
    }
    const rec = parsed as Record<string, unknown>
    if (Object.keys(rec).some((key) => (EXTRA_BODY_FORBIDDEN as readonly string[]).includes(key))) {
      setExtraError('不能覆盖 model、messages 等字段')
      return
    }
    setExtraError(null)
    void savePatch({ extraBody: rec })
  }

  const previewModel = props.provider.models[0]?.id ?? '<模型>'
  const remoteIds = new Set(remoteModels.map((item) => item.id))

  return (
    <form className="flex max-w-2xl flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
      <Switch
        isSelected={props.provider.enabled}
        onChange={(enabled) => void savePatch({ enabled })}
      >
        {/* Switch.Content is the clickable <label>; the control must sit inside it. */}
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          启用
        </Switch.Content>
      </Switch>
      <TextField
        value={name}
        onChange={(value) => {
          setName(value)
          if (nameError) setNameError(nameProblem(value))
        }}
        isInvalid={Boolean(nameError)}
        onBlur={() => {
          const problem = nameProblem(name)
          setNameError(problem)
          if (problem) return
          const trimmed = name.trim()
          setName(trimmed)
          if (trimmed !== savedProvider(props.provider).name) void savePatch({ name: trimmed })
        }}
      >
        <Label>名称</Label>
        <Input />
        {nameError ? <FieldError>{nameError}</FieldError> : null}
      </TextField>
      <div>
        <p className="text-sm">接口类型</p>
        <p className="text-sm text-foreground/70">{PROVIDER_TYPE_LABELS[props.provider.type]}</p>
      </div>
      <TextField
        value={baseUrl}
        onChange={(value) => {
          setBaseUrl(value)
          if (baseUrlError) setBaseUrlError(baseUrlProblem(value))
        }}
        isInvalid={Boolean(baseUrlError)}
        onBlur={() => {
          const url = validBaseUrl()
          if (!url) return
          setBaseUrl(url)
          if (url !== savedProvider(props.provider).baseUrl) void savePatch({ baseUrl: url })
        }}
      >
        <Label>API 地址</Label>
        <Input placeholder="https://…/v1" />
        {baseUrlError ? <FieldError>{baseUrlError}</FieldError> : null}
        <Description>
          请求地址：{chatUrl({ type: props.provider.type, baseUrl }, previewModel)}
        </Description>
      </TextField>
      <Card>
        <Card.Header>
          <Card.Title>API Key</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <p className="text-sm">
            {props.provider.keyOptional
              ? '本机服务，无需 Key'
              : props.provider.keyConfigured
                ? `已保存 ${props.provider.keyMasked}`
                : '未填写'}
          </p>
          <TextField aria-label="API Key" value={keyDraft} onChange={setKeyDraft}>
            <Input
              type="password"
              placeholder={props.provider.keyConfigured ? '输入新的 Key 以替换' : '粘贴 API Key'}
            />
          </TextField>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              isDisabled={!keyDraft.trim()}
              onPress={() => void saveKey(keyDraft.trim())}
            >
              保存
            </Button>
            {props.provider.keyConfigured ? (
              <Button variant="ghost" onPress={() => void saveKey(null)}>
                移除
              </Button>
            ) : null}
            {props.provider.keyUrl ? (
              <Button
                variant="ghost"
                onPress={() => {
                  const url = props.provider.keyUrl
                  if (url) invoke('shell:openExternal', { url }).catch(notifyError)
                }}
              >
                获取 API Key
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-foreground/60">
            多个 Key 用英文逗号分隔，请求会轮流使用；某个 Key 失效或余额不足时自动改用其余的。Key
            只保存在本机，用系统加密保护。
          </p>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>模型</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          {props.provider.models.map((model) => (
            <div key={model.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{model.name ?? model.id}</span>
              <Tooltip>
                {/* The trigger is a focusable div role="button"; around a real Button that
                    makes a nested control with two tab stops, so it only listens for hover. */}
                <Tooltip.Trigger role="presentation" tabIndex={-1}>
                  <Button
                    size="sm"
                    isPending={checking.has(model.id)}
                    onPress={() => void checkModel(model.id)}
                  >
                    检查
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Content>用这个模型发送一个测试请求</Tooltip.Content>
              </Tooltip>
              <CloseButton
                aria-label={`删除 ${model.id}`}
                onPress={() =>
                  void savePatch({
                    models: savedProvider(props.provider).models.filter(
                      (item) => item.id !== model.id,
                    ),
                  })
                }
              />
              {checks[model.id] ? (
                <span
                  className={checks[model.id]?.startsWith('可用') ? 'text-success' : 'text-danger'}
                >
                  {checks[model.id]}
                </span>
              ) : null}
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onPress={() => {
                setAddModelKey((current) => current + 1)
                setAddModelOpen(true)
              }}
            >
              手动添加…
            </Button>
            <Button variant="primary" isPending={listing} onPress={() => void fetchModels()}>
              获取模型列表…
            </Button>
          </div>
        </Card.Content>
      </Card>
      <NumberFieldLike
        value={props.provider.concurrency}
        onChange={(concurrency) => void savePatch({ concurrency })}
      />
      <TextField isInvalid={Boolean(extraError)} value={extra} onChange={setExtra}>
        <Label>附加请求参数（JSON，可选）</Label>
        <TextArea className="font-mono" />
        {extraError ? <FieldError>{extraError}</FieldError> : null}
        <Description>
          合并进每个请求，例如 {'{"temperature": 0.3}'}，或关闭思考模式的参数。
        </Description>
      </TextField>
      <Button className="w-fit" onPress={applyExtra}>
        应用
      </Button>
      <AddModelModal
        key={addModelKey}
        isOpen={addModelOpen}
        onOpenChange={setAddModelOpen}
        existing={props.provider.models.map((item) => item.id)}
        onAdd={(id) => {
          const saved = savedProvider(props.provider)
          if (saved.models.some((item) => item.id === id)) return
          void savePatch({ models: [...saved.models, { id }] })
        }}
      />
      <PickModelsModal
        key={pickOpen ? 'open' : 'closed'}
        isOpen={pickOpen}
        onOpenChange={setPickOpen}
        providerName={props.provider.name}
        models={remoteModels}
        // Preselect only saved models the remote list offers; manually added ones stay as
        // they are and must not come back as picks (duplicate ids fail the schema).
        selected={props.provider.models.map((item) => item.id).filter((id) => remoteIds.has(id))}
        onConfirm={(ids) => {
          const result = pickModels(savedProvider(props.provider).models, remoteModels, ids)
          void savePatch({ models: result.models }).then((ok) => {
            if (ok) notify.success(`已添加 ${result.added} 个、移除 ${result.removed} 个模型。`)
          })
        }}
      />
    </form>
  )
}

/**
 * Applies a model-list pick: saved models the remote list offers follow the picks, manually
 * added ones stay; saved entries keep their order and names, new picks follow in remote order.
 */
function pickModels(
  saved: readonly ModelConfig[],
  remote: readonly ModelInfo[],
  ids: readonly string[],
): { models: ModelConfig[]; added: number; removed: number } {
  const picked = new Set(ids)
  const remoteIds = new Set(remote.map((item) => item.id))
  const kept = saved.filter((item) => !remoteIds.has(item.id) || picked.has(item.id))
  const keptIds = new Set(kept.map((item) => item.id))
  const additions: ModelConfig[] = remote
    .filter((item) => picked.has(item.id) && !keptIds.has(item.id))
    .map((item) => (item.name ? { id: item.id, name: item.name } : { id: item.id }))
  return {
    models: [...kept, ...additions],
    added: additions.length,
    removed: saved.length - kept.length,
  }
}

function NumberFieldLike(props: { value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(props.value))
  return (
    <TextField
      value={text}
      onChange={setText}
      onBlur={() => {
        const n = Number(text)
        if (Number.isInteger(n) && n >= 1 && n <= 2000) {
          if (n !== props.value) props.onChange(n)
        } else setText(String(props.value))
      }}
    >
      <Label>并发请求数</Label>
      <Input />
      <Description>
        同时发往这个服务商的请求上限，所有文档共用；默认 100。遇到限流（HTTP
        429）会自动减半，恢复后逐步回升。
      </Description>
    </TextField>
  )
}

function AddModelModal(props: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  existing: readonly string[]
  onAdd: (id: string) => void
}) {
  const [id, setId] = useState('')
  const trimmed = id.trim()
  const problem = !trimmed
    ? null
    : props.existing.includes(trimmed)
      ? '这个模型已在列表中'
      : ModelConfig.shape.id.safeParse(trimmed).success
        ? null
        : '模型 ID 不能超过 256 个字符'
  // Controlled modal without a trigger: drive Modal.Backdrop directly (HeroUI "Controlled"
  // example). A trigger-less <Modal> root is a DialogTrigger with no pressable child.
  return (
    <Modal.Backdrop isDismissable isOpen={props.isOpen} onOpenChange={props.onOpenChange}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>添加模型</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <TextField value={id} onChange={setId} isInvalid={Boolean(problem)} autoFocus>
              <Label>模型 ID</Label>
              <Input />
              {problem ? <FieldError>{problem}</FieldError> : null}
              <Description>与服务商文档中的模型名称一致，例如 deepseek-chat。</Description>
            </TextField>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={() => props.onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              isDisabled={!trimmed || Boolean(problem)}
              onPress={() => {
                props.onAdd(trimmed)
                props.onOpenChange(false)
              }}
            >
              添加
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function PickModelsModal(props: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  providerName: string
  models: ModelInfo[]
  selected: string[]
  onConfirm: (ids: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(props.selected))
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return props.models
    return props.models.filter((item) =>
      `${item.id} ${item.name ?? ''} ${item.ownedBy ?? ''}`.toLowerCase().includes(q),
    )
  }, [props.models, query])
  return (
    <Modal.Backdrop isDismissable isOpen={props.isOpen} onOpenChange={props.onOpenChange}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{props.providerName} 的模型</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex max-h-[60vh] flex-col gap-3">
            <SearchField aria-label="搜索模型" value={query} onChange={setQuery}>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={`在 ${props.models.length} 个模型中搜索`} />
              </SearchField.Group>
            </SearchField>
            <ListBox
              aria-label="模型"
              selectionMode="multiple"
              selectedKeys={picked}
              onSelectionChange={(keys) => {
                // "Select all" covers the visible (filtered) rows; picks hidden by the search
                // stay picked.
                if (keys === 'all') {
                  setPicked((current) => new Set([...current, ...filtered.map((item) => item.id)]))
                } else setPicked(new Set([...keys].map(String)))
              }}
              className="min-h-0 flex-1 overflow-auto"
            >
              {filtered.map((model) => (
                <ListBox.Item key={model.id} id={model.id} textValue={model.id}>
                  <div className="flex flex-col">
                    <span>{model.id}</span>
                    <span className="text-xs text-foreground/60">
                      {[
                        model.name,
                        model.ownedBy,
                        model.contextLength ? `${Math.round(model.contextLength / 1000)}K` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {/* HeroUI 3 draws no selected state on its own; the indicator shows it. */}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
            <p className="text-sm">已选择 {picked.size} 个模型</p>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={() => props.onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onPress={() => {
                props.onConfirm([...picked])
                props.onOpenChange(false)
              }}
            >
              确定
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function CustomProviderModal(props: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const view = useSettingsStore((s) => s.view)
  const apply = useSettingsStore((s) => s.apply)
  const select = useSettingsStore((s) => s.selectProvider)
  const [name, setName] = useState('')
  const [type, setType] = useState<ProviderType>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  if (!view) return null

  async function add() {
    const nameIssue = nameProblem(name)
    const urlIssue = baseUrlProblem(baseUrl)
    setNameError(nameIssue)
    setBaseUrlError(urlIssue)
    if (nameIssue || urlIssue) return
    const current = useSettingsStore.getState().view ?? view
    const id = uniqueProviderId(
      'custom',
      (current?.providers ?? []).map((item) => item.id),
    )
    const parsed = ProviderConfig.safeParse({
      id,
      name: name.trim(),
      type,
      baseUrl,
      enabled: true,
      models: [],
      concurrency: 100,
    })
    if (!parsed.success) {
      notify.danger(`设置未保存：${providerIssueMessage(parsed.error)}`)
      return
    }
    setPending(true)
    try {
      const next = (await invoke('providers:save', { provider: parsed.data })) as SettingsView
      apply(next)
      select(id)
      props.onOpenChange(false)
    } catch (error) {
      notifyError(error, '设置未保存：')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal.Backdrop isDismissable isOpen={props.isOpen} onOpenChange={props.onOpenChange}>
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>自定义服务商</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            <TextField
              value={name}
              onChange={(value) => {
                setName(value)
                if (nameError) setNameError(nameProblem(value))
              }}
              isInvalid={Boolean(nameError)}
            >
              <Label>名称</Label>
              <Input placeholder="例如 公司网关" />
              {nameError ? <FieldError>{nameError}</FieldError> : null}
            </TextField>
            <Select
              value={type}
              onChange={(key) => {
                if (typeof key === 'string') setType(key as ProviderType)
              }}
            >
              <Label>接口类型</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                {/* HeroUI list-box items render children through a function, so react-aria
                      cannot infer textValue from them; it must be given explicitly. */}
                <ListBox>
                  <ListBox.Item id="openai" textValue="OpenAI 兼容（最常见）">
                    OpenAI 兼容（最常见）
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  <ListBox.Item id="anthropic" textValue="Anthropic">
                    Anthropic
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  <ListBox.Item id="gemini" textValue="Gemini">
                    Gemini
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  <ListBox.Item id="azure" textValue="Azure OpenAI">
                    Azure OpenAI
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
            <TextField
              value={baseUrl}
              onChange={(value) => {
                setBaseUrl(value)
                if (baseUrlError) setBaseUrlError(baseUrlProblem(value))
              }}
              onBlur={() => {
                if (baseUrl.trim()) setBaseUrlError(baseUrlProblem(baseUrl))
              }}
              isInvalid={Boolean(baseUrlError)}
            >
              <Label>API 地址</Label>
              <Input />
              {baseUrlError ? <FieldError>{baseUrlError}</FieldError> : null}
              <Description>
                OpenAI 兼容接口填写到 /v1 为止，程序会在后面加上 /chat/completions。
              </Description>
            </TextField>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={() => props.onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              isPending={pending}
              isDisabled={!name.trim() || !baseUrl.trim()}
              onPress={() => void add()}
            >
              添加
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
