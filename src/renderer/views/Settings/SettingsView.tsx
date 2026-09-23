import {
  Button,
  Card,
  Description,
  FieldError,
  Input,
  Label,
  Link,
  NumberField,
  Radio,
  RadioGroup,
  Slider,
  Switch,
  Tabs,
  TextArea,
  TextField,
} from '@heroui/react'
import { useState } from 'react'
import { DEFAULT_SYSTEM_PROMPT } from '../../../shared/constants'
import { ProxyConfig } from '../../../shared/types'
import { invoke } from '../../api/invoke'
import { TranslatorSelect } from '../../components/TranslatorSelect'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { notifyError } from '../../lib/notify'
import { defaultTranslatorKey, parseTranslatorKey, translatorOptions } from '../../lib/translators'
import { useDocumentsStore } from '../../store/documents'
import { useSettingsStore } from '../../store/settings'
import { useUiStore, type SettingsTab } from '../../store/ui'
import { ProvidersPanel } from './ProvidersPanel'

export function SettingsView() {
  const tab = useUiStore((s) => s.settingsTab)
  const setTab = useUiStore((s) => s.setSettingsTab)
  return (
    <div className="flex min-h-0 flex-1">
      <Tabs
        orientation="vertical"
        selectedKey={tab}
        onSelectionChange={(key) => {
          if (typeof key === 'string') setTab(key as SettingsTab)
        }}
        className="flex min-h-0 flex-1"
      >
        <Tabs.ListContainer className="w-[180px] shrink-0 border-r border-separator p-2">
          <Tabs.List aria-label="设置">
            <Tabs.Tab id="general">
              通用
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="providers">
              翻译服务
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="network">
              网络
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="advanced">
              高级
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="about">
              关于
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="general" className="min-h-0 flex-1 overflow-auto p-6">
          <GeneralPanel />
        </Tabs.Panel>
        <Tabs.Panel id="providers" className="min-h-0 flex-1 overflow-hidden p-0">
          <ProvidersPanel />
        </Tabs.Panel>
        <Tabs.Panel id="network" className="min-h-0 flex-1 overflow-auto p-6">
          <NetworkPanel />
        </Tabs.Panel>
        <Tabs.Panel id="advanced" className="min-h-0 flex-1 overflow-auto p-6">
          <AdvancedPanel />
        </Tabs.Panel>
        <Tabs.Panel id="about" className="min-h-0 flex-1 overflow-auto p-6">
          <AboutPanel />
        </Tabs.Panel>
      </Tabs>
    </div>
  )
}

function GeneralPanel() {
  const view = useSettingsStore((s) => s.view)
  const update = useSettingsStore((s) => s.update)
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const appInfo = useUiStore((s) => s.appInfo)
  const options = translatorOptions(view)
  const [pendingFolder, setPendingFolder] = useState<string | null>(null)
  if (!view || !appInfo) return null
  const reveal = appInfo.platform === 'win32' ? '在文件资源管理器中显示' : '在访达中显示'
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <Card>
        <Card.Header>
          <Card.Title>新建翻译</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <TranslatorSelect
            label="默认翻译模型"
            options={options}
            selectedKey={defaultTranslatorKey(view)}
            emptyLabel="尚未添加大模型服务商"
            onChange={(key) => {
              const parsed = parseTranslatorKey(key)
              if (parsed) void update({ defaultTranslator: parsed })
            }}
          />
          <NumberField
            value={view.workerConcurrency}
            minValue={1}
            maxValue={4}
            onChange={(value) => {
              // Clearing the input reports NaN; ignore it instead of sending an invalid patch.
              if (Number.isFinite(value)) void update({ workerConcurrency: value })
            }}
          >
            <Label>同时处理的文档数</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            <Description>
              同时处理更多文档会占用更多 CPU 和内存，翻译请求的并发由各服务商的“并发请求数”控制。
            </Description>
          </NumberField>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>外观</Card.Title>
        </Card.Header>
        <Card.Content>
          <RadioGroup
            value={theme}
            onChange={(value) => {
              setTheme(value as typeof theme).catch(notifyError)
            }}
          >
            <Label>主题</Label>
            <Radio value="system">
              <Radio.Content>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                跟随系统
              </Radio.Content>
            </Radio>
            <Radio value="light">
              <Radio.Content>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                浅色
              </Radio.Content>
            </Radio>
            <Radio value="dark">
              <Radio.Content>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                深色
              </Radio.Content>
            </Radio>
          </RadioGroup>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>文档库</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <div>
            <p className="text-sm">位置</p>
            <p className="selectable text-sm text-foreground/70" title={appInfo.libraryDir}>
              {appInfo.libraryDir}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  invoke('documents:reveal', { id: '', kind: 'folder' }).catch(notifyError)
                }}
              >
                {reveal}
              </Button>
              <Button
                size="sm"
                isDisabled={appInfo.dataDirFromEnv}
                onPress={() => {
                  invoke('dialog:pickFolder', {
                    title: '选择文档库位置',
                    message: '选择存放文档库的文件夹，DocFlow 会在其中使用“DocFlow”文件夹。',
                  })
                    .then((picked) => {
                      if ('cancelled' in picked) return
                      setPendingFolder(picked.path)
                    })
                    .catch(notifyError)
                }}
              >
                更改…
              </Button>
            </div>
            {appInfo.dataDirFromEnv ? (
              <p className="mt-1 text-xs text-foreground/60">由环境变量 DOCFLOW_DATA_DIR 指定</p>
            ) : null}
          </div>
          <div>
            <p className="text-sm">日志</p>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                invoke('shell:openLogs', {}).catch(notifyError)
              }}
            >
              打开日志文件夹
            </Button>
          </div>
          <p className="text-xs text-foreground/60">文档库保存源文件副本、译文、PDF 和处理记录。</p>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>通知</Card.Title>
        </Card.Header>
        <Card.Content>
          <Switch
            isSelected={view.notifications}
            onChange={(value) => void update({ notifications: value })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              翻译完成或失败时发送系统通知
            </Switch.Content>
          </Switch>
        </Card.Content>
      </Card>
      <ConfirmDialog
        isOpen={Boolean(pendingFolder)}
        title="更改文档库位置？"
        body="DocFlow 会在新位置使用独立的文档库，现有文档保留在原位置，改回原位置即可再次看到。进行中的任务会在下次打开对应文档库时继续。"
        confirmLabel="更改"
        onOpenChange={(open) => {
          if (!open) setPendingFolder(null)
        }}
        onConfirm={async () => {
          if (!pendingFolder) return
          const result = await invoke('library:change', { path: pendingFolder })
          const ui = useUiStore.getState()
          // setAppInfo also resets `theme`; keep the theme chosen in this session.
          if (ui.appInfo) {
            ui.setAppInfo({ ...ui.appInfo, theme: ui.theme, libraryDir: result.libraryDir })
          }
          await useDocumentsStore.getState().list()
          setPendingFolder(null)
        }}
      />
    </div>
  )
}

const PROXY_URL_INVALID = '请填写完整的代理地址，例如 http://127.0.0.1:7890'

function NetworkPanel() {
  const view = useSettingsStore((s) => s.view)
  const update = useSettingsStore((s) => s.update)
  // Choosing “自定义” only shows the address field; nothing is saved until “应用” with a
  // valid address, so an unreachable placeholder never becomes the active proxy.
  const [modeDraft, setModeDraft] = useState<'custom' | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  if (!view) return null
  const savedUrl = view.proxy.mode === 'custom' ? view.proxy.url : ''
  const mode = modeDraft ?? view.proxy.mode
  const customUrl = draft ?? savedUrl

  async function applyCustom() {
    const parsed = ProxyConfig.safeParse({ mode: 'custom', url: customUrl })
    if (!parsed.success) {
      setError(PROXY_URL_INVALID)
      return
    }
    setError(null)
    setPending(true)
    const saved = await update({ proxy: parsed.data })
    setPending(false)
    if (!saved) return
    setModeDraft(null)
    setDraft(null)
  }

  return (
    <div className="mx-auto max-w-2xl">
      <RadioGroup
        value={mode}
        onChange={(next) => {
          if (next === 'custom') {
            setModeDraft('custom')
            return
          }
          if (next !== 'system' && next !== 'direct') return
          // Keep the last custom address around in case the user switches back.
          if (view.proxy.mode === 'custom' && draft === null) setDraft(view.proxy.url)
          setModeDraft(null)
          setError(null)
          void update({ proxy: { mode: next } })
        }}
      >
        <Label>代理</Label>
        <Radio value="system">
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            跟随系统
          </Radio.Content>
        </Radio>
        <Radio value="direct">
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            不使用代理
          </Radio.Content>
        </Radio>
        <Radio value="custom">
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            自定义
          </Radio.Content>
        </Radio>
      </RadioGroup>
      {mode === 'custom' ? (
        <div className="mt-3 flex items-start gap-2">
          <TextField
            value={customUrl}
            onChange={(value) => {
              setDraft(value)
              if (error) setError(null)
            }}
            isInvalid={Boolean(error)}
            className="flex-1"
          >
            <Label>代理地址</Label>
            <Input placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" />
            {error ? <FieldError>{error}</FieldError> : null}
          </TextField>
          <Button
            className="mt-6"
            isDisabled={!customUrl.trim()}
            isPending={pending}
            onPress={() => void applyCustom()}
          >
            应用
          </Button>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-foreground/60">
        访问大模型服务商时使用的网络代理。“跟随系统”会读取系统设置中的代理。
      </p>
    </div>
  )
}

function AdvancedPanel() {
  const view = useSettingsStore((s) => s.view)
  const update = useSettingsStore((s) => s.update)
  const [draft, setDraft] = useState<string | null>(null)
  // Local value while the slider is dragged; committed to settings on change end.
  const [scaleDraft, setScaleDraft] = useState<number | null>(null)
  if (!view) return null
  const prompt = draft ?? view.translation.systemPrompt
  const llm = view.translation.llm
  const minFontScale = scaleDraft ?? view.pdf.minFontScale
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <Card>
        <Card.Header>
          <Card.Title>大模型请求</Card.Title>
        </Card.Header>
        <Card.Content className="grid gap-3">
          <Num
            label="每段最多字符"
            value={llm.chunkChars}
            min={100}
            max={32000}
            step={100}
            onChange={(chunkChars) => void update({ translation: { llm: { chunkChars } } })}
          />
          <Num
            label="单次请求最多段数"
            value={llm.maxSegmentsPerRequest}
            min={1}
            max={64}
            onChange={(maxSegmentsPerRequest) =>
              void update({ translation: { llm: { maxSegmentsPerRequest } } })
            }
          />
          <Num
            label="单次请求最多字符"
            value={llm.maxRequestChars}
            min={500}
            max={100000}
            step={500}
            onChange={(maxRequestChars) =>
              void update({ translation: { llm: { maxRequestChars } } })
            }
          />
          <Num
            label="最大输出 tokens"
            value={llm.maxOutputTokens}
            min={0}
            max={1000000}
            step={1024}
            description="0 = 使用服务商默认值"
            onChange={(maxOutputTokens) =>
              void update({ translation: { llm: { maxOutputTokens } } })
            }
          />
          <Num
            label="单个文档最多同时发出的请求数"
            value={view.translation.perDocumentConcurrency}
            min={1}
            max={1000}
            onChange={(perDocumentConcurrency) =>
              void update({ translation: { perDocumentConcurrency } })
            }
          />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>翻译提示词</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <TextField aria-label="翻译提示词" value={prompt} onChange={setDraft}>
            <TextArea rows={8} className="font-mono" />
            <Description>
              {prompt.length} /
              12000。公式、代码、链接和排版标记由程序在本地保护，提示词无需说明这些规则。新任务使用新参数，进行中的任务保持提交时的设置。
            </Description>
          </TextField>
          <div className="flex gap-2">
            <Button variant="secondary" onPress={() => setDraft(DEFAULT_SYSTEM_PROMPT)}>
              恢复默认
            </Button>
            <Button
              onPress={() => {
                void update({ translation: { systemPrompt: prompt } }).then((saved) => {
                  if (saved) setDraft(null)
                })
              }}
            >
              保存
            </Button>
          </div>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>PDF 写回</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div>
            <Slider
              value={minFontScale}
              minValue={0.4}
              maxValue={1}
              step={0.01}
              onChange={(value) => {
                const n = Array.isArray(value) ? value[0] : value
                if (typeof n === 'number') setScaleDraft(n)
              }}
              onChangeEnd={(value) => {
                const n = Array.isArray(value) ? value[0] : value
                if (typeof n !== 'number') return
                void update({ pdf: { minFontScale: n } }).then(() => setScaleDraft(null))
              }}
            >
              <Label>译文最小缩放</Label>
              <Slider.Output>{`${Math.round(minFontScale * 100)}%`}</Slider.Output>
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
            <p className="mt-1 text-xs text-foreground/60">
              译文装不下时允许把字号缩小到原字号的这个比例
            </p>
          </div>
          <Switch
            isSelected={view.pdf.bilingual}
            onChange={(bilingual) => void update({ pdf: { bilingual } })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              同时生成双语对照 PDF
            </Switch.Content>
          </Switch>
        </Card.Content>
      </Card>
    </div>
  )
}

function Num(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  description?: string
  onChange: (value: number) => void
}) {
  return (
    <NumberField
      value={props.value}
      minValue={props.min}
      maxValue={props.max}
      {...(props.step === undefined ? {} : { step: props.step })}
      onChange={(value) => {
        // Clearing the input reports NaN; ignore it instead of sending an invalid patch.
        if (Number.isFinite(value)) props.onChange(value)
      }}
    >
      <Label>{props.label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input />
        <NumberField.IncrementButton />
      </NumberField.Group>
      {props.description ? <Description>{props.description}</Description> : null}
    </NumberField>
  )
}

function AboutPanel() {
  const appInfo = useUiStore((s) => s.appInfo)
  const view = useSettingsStore((s) => s.view)
  const update = useSettingsStore((s) => s.update)
  const [result, setResult] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  if (!appInfo || !view) return null

  async function checkUpdates() {
    setChecking(true)
    try {
      const check = await invoke('app:checkUpdates', {})
      if ('error' in check) {
        setResult(check.error)
        setUrl(null)
      } else if (check.newer) {
        setResult(`有新版本 ${check.latest.replace(/^v/, '')}`)
        setUrl(check.url)
      } else {
        setResult('已是最新版本')
        setUrl(null)
      }
    } catch (error) {
      notifyError(error)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">DocFlow</h2>
        <p className="text-sm text-foreground/70">
          版本 {appInfo.version} · {appInfo.platform} · {appInfo.arch}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button isPending={checking} onPress={() => void checkUpdates()}>
          检查更新
        </Button>
        {result ? <span className="text-sm">{result}</span> : null}
        {url ? (
          <Button
            size="sm"
            variant="secondary"
            onPress={() => {
              invoke('shell:openExternal', { url }).catch(notifyError)
            }}
          >
            前往下载
          </Button>
        ) : null}
      </div>
      <Switch
        isSelected={view.checkUpdates}
        onChange={(checkUpdates) => void update({ checkUpdates })}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          启动时自动检查更新
        </Switch.Content>
      </Switch>
      <div className="flex flex-col gap-2 text-sm">
        {/* No href: an <a href> would also navigate the window (caught by will-navigate,
            which opens the URL a second time); onPress alone opens it once. */}
        <Link
          onPress={() => {
            invoke('shell:openExternal', { url: 'https://github.com/Uniseem/docflow' }).catch(
              notifyError,
            )
          }}
        >
          源代码
        </Link>
        <Button
          variant="ghost"
          className="w-fit"
          onPress={() => {
            invoke('shell:openNotices', {}).catch(notifyError)
          }}
        >
          第三方许可
        </Button>
        <Button
          variant="ghost"
          className="w-fit"
          onPress={() => {
            invoke('shell:openLogs', {}).catch(notifyError)
          }}
        >
          打开日志文件夹
        </Button>
      </div>
    </div>
  )
}
