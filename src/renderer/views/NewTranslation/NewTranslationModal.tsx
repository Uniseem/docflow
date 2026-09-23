import { Alert, Button, CloseButton, Label, Modal, TextField, Input } from '@heroui/react'
import { FileText } from 'lucide-react'
import { useState } from 'react'
import { MAX_PDF_BYTES } from '../../../shared/constants'
import { formatBytes } from '../../../shared/text'
import { invoke } from '../../api/invoke'
import { TranslatorSelect } from '../../components/TranslatorSelect'
import { basename, fileStem } from '../../lib/labels'
import { notify, notifyError } from '../../lib/notify'
import { defaultTranslatorKey, parseTranslatorKey, translatorOptions } from '../../lib/translators'
import { useDocumentsStore } from '../../store/documents'
import { useSettingsStore } from '../../store/settings'
import { useUiStore } from '../../store/ui'

type PendingFile = { path: string; size?: number; problem?: string }

export function NewTranslationModal() {
  const open = useUiStore((s) => s.newTranslationOpen)
  const preset = useUiStore((s) => s.newTranslationPaths)
  const close = useUiStore((s) => s.closeNewTranslation)
  const setView = useUiStore((s) => s.setView)
  const setSettingsTab = useUiStore((s) => s.setSettingsTab)
  const settings = useSettingsStore((s) => s.view)
  const options = translatorOptions(settings)
  const [files, setFiles] = useState<PendingFile[]>(() => mergePaths([], preset))
  // Paths pushed while the modal is already open (a second drop, app:openFiles) arrive as a
  // new preset array without remounting the modal, so merge them into the list here.
  const [seenPreset, setSeenPreset] = useState(preset)
  if (preset !== seenPreset) {
    setSeenPreset(preset)
    setFiles((current) => mergePaths(current, preset))
  }
  const [pickedKey, setPickedKey] = useState<string | null>(() => defaultTranslatorKey(settings))
  // Settings may still be loading when the modal opens (e.g. macOS open-file at launch);
  // fall back to the default once they arrive instead of leaving nothing selected.
  const translatorKey = pickedKey ?? defaultTranslatorKey(settings)
  // null until the user edits the title: the field then shows the current file's stem, and
  // no title is sent, so the PDF's own metadata title can still replace the filename (05 §5.7).
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const onlyFile = files.length === 1 ? files[0] : undefined
  const title = titleDraft ?? (onlyFile ? fileStem(basename(onlyFile.path)) : '')
  const [pending, setPending] = useState(false)
  const [failures, setFailures] = useState<Array<{ path: string; message: string }>>([])

  const problems = files.filter((file) => file.problem)
  const canSubmit =
    files.length > 0 &&
    problems.length === 0 &&
    Boolean(translatorKey) &&
    options.some((item) => item.key === translatorKey)

  const translatorMissing = options.length === 0
  const translatorStale =
    Boolean(translatorKey) && !options.some((item) => item.key === translatorKey)

  async function addFromDialog() {
    try {
      const { paths } = await invoke('dialog:pickPdfs', {})
      setFiles((current) => mergePaths(current, paths))
    } catch (error) {
      // A failed picker leaves the list unchanged.
      notifyError(error)
    }
  }

  async function submit() {
    const parsed = translatorKey ? parseTranslatorKey(translatorKey) : null
    if (!parsed || !canSubmit) return
    setPending(true)
    setFailures([])
    try {
      const customTitle = files.length === 1 && titleDraft !== null ? titleDraft.trim() : ''
      const payload = customTitle
        ? { paths: files.map((file) => file.path), translator: parsed, title: customTitle }
        : { paths: files.map((file) => file.path), translator: parsed }
      const result = await invoke('documents:create', payload)
      if (result.created.length > 0) {
        notify.success(`已添加 ${result.created.length} 个文档`)
        const docs = useDocumentsStore.getState()
        if (docs.filter === 'completed' || docs.filter === 'failed') docs.setFilter('all')
        for (const item of result.created) docs.upsert(item)
        docs.select(result.created[0]?.id ?? null)
      }
      if (result.failed.length === 0) {
        close()
        return
      }
      setFailures(result.failed)
      setFiles((current) =>
        current.filter((file) => result.failed.some((fail) => fail.path === file.path)),
      )
    } catch (error) {
      // The whole request was rejected (e.g. the model was removed meanwhile): keep every file
      // and show the reason in the failure alert instead of failing silently.
      const message = error instanceof Error ? error.message : String(error)
      setFailures(files.map((file) => ({ path: file.path, message })))
    } finally {
      setPending(false)
    }
  }

  return (
    // Controlled via Modal.Backdrop isOpen/onOpenChange (the documented controlled pattern);
    // a <Modal> root without a trigger child only wraps an empty DialogTrigger.
    <Modal.Backdrop
      isDismissable
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <Modal.Container size="lg">
        <Modal.Dialog
          // Enter submits. The handler sits on the dialog element itself so it also works while
          // focus is still on the dialog right after opening (Modal.Dialog does not forward
          // onKeyDown, hence the render prop). Buttons stop propagation of their own Enter.
          render={(domProps) => (
            <section
              {...domProps}
              onKeyDown={(event) => {
                domProps.onKeyDown?.(event)
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                if (event.defaultPrevented || !canSubmit || pending) return
                event.preventDefault()
                void submit()
              }}
            />
          )}
        >
          <Modal.Header>
            <Modal.Heading>新建翻译</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <div>
              <p className="mb-2 text-sm font-medium">文件</p>
              {files.length === 0 ? (
                <div className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-separator px-4 py-8 text-sm">
                  将文件拖到这里
                  <Button variant="secondary" onPress={() => void addFromDialog()}>
                    选择文件…
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-start gap-2">
                  <ul className="flex w-full flex-col gap-2">
                    {files.map((file) => (
                      <li key={file.path} className="flex items-center gap-2 text-sm">
                        <FileText size={16} />
                        <span className="min-w-0 flex-1 truncate" title={file.path}>
                          {basename(file.path)}
                        </span>
                        {file.problem ? (
                          <span className="text-danger">{file.problem}</span>
                        ) : file.size != null ? (
                          <span className="text-foreground/60">{formatBytes(file.size)}</span>
                        ) : null}
                        <CloseButton
                          aria-label="移除这个文件"
                          onPress={() =>
                            setFiles((current) => current.filter((item) => item.path !== file.path))
                          }
                        />
                      </li>
                    ))}
                  </ul>
                  <Button variant="ghost" onPress={() => void addFromDialog()}>
                    添加文件…
                  </Button>
                </div>
              )}
              <p className="mt-2 text-xs text-foreground/60">
                只支持带文本层的 PDF；扫描件、加密文件和 Office 文档无法处理。
              </p>
            </div>
            <TranslatorSelect
              label="翻译模型"
              options={options}
              selectedKey={translatorKey}
              onChange={setPickedKey}
              emptyLabel="尚未添加"
            />
            <p className="text-xs text-foreground/60">
              由所选的大模型翻译；速度和费用取决于服务商和模型。
            </p>
            {files.length === 1 ? (
              <TextField value={title} onChange={setTitleDraft}>
                <Label>标题</Label>
                <Input placeholder="默认使用文件名" />
              </TextField>
            ) : null}
            {translatorMissing ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>
                    还没有可用的大模型：请在设置的“翻译服务”中添加服务商、填写 API Key 并获取模型。
                  </Alert.Title>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      close()
                      setSettingsTab('providers')
                      setView('settings')
                    }}
                  >
                    打开设置…
                  </Button>
                </Alert.Content>
              </Alert>
            ) : null}
            {translatorStale ? (
              <Alert status="warning">
                <Alert.Content>
                  <Alert.Title>所选的模型已停用或已删除，请换一个模型。</Alert.Title>
                </Alert.Content>
              </Alert>
            ) : null}
            {failures.length > 0 ? (
              <Alert status="danger">
                <Alert.Content>
                  <Alert.Title>部分文件未能添加</Alert.Title>
                  <Alert.Description>
                    {failures.map((fail) => (
                      // Alert.Description renders a <span>, so keep the rows phrasing content.
                      <span key={fail.path} className="block">
                        {basename(fail.path)}：{fail.message}
                      </span>
                    ))}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={close}>
              取消
            </Button>
            <Button
              variant="primary"
              isDisabled={!canSubmit}
              isPending={pending}
              onPress={() => void submit()}
            >
              {files.length > 1 ? `开始翻译 ${files.length} 个文件` : '开始翻译'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

/** Appends paths not already listed (deduplicated by absolute path), validating each one. */
function mergePaths(current: PendingFile[], paths: readonly string[]): PendingFile[] {
  const added: PendingFile[] = []
  for (const path of paths) {
    if (!path) continue
    if (current.some((item) => item.path === path) || added.some((item) => item.path === path))
      continue
    added.push(validateFile({ path }))
  }
  return added.length === 0 ? current : [...current, ...added]
}

function validateFile(input: { path: string; size?: number }): PendingFile {
  const file: PendingFile = { path: input.path }
  if (input.size !== undefined) file.size = input.size
  if (!input.path.toLowerCase().endsWith('.pdf')) file.problem = '只支持 .pdf 文件'
  else if (input.size === 0) file.problem = '文件为空'
  else if (input.size !== undefined && input.size > MAX_PDF_BYTES) file.problem = '文件超过 500 MB'
  return file
}
