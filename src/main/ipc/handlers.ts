import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ERROR_CODES, UserError, isUserError } from '../../shared/errors'
import { MAX_PROVIDERS } from '../../shared/constants'
import type { ChannelRequest, ChannelResponse } from '../../shared/ipc'
import { translatorLabel, ProviderConfig } from '../../shared/types'
import { pickFolder, pickPdfs, saveExport, type DialogHost } from '../app/dialogs'
import { exportBundle } from '../library/export'
import type { DocumentLibrary } from '../library/library'
import type { Scheduler } from '../jobs/scheduler'
import type { SettingsStore } from '../settings/settings'
import type { SecretsStore } from '../settings/secrets'
import { toSettingsView } from '../settings/view'
import { ensureLibraryFolderName } from '../settings/host'
import { checkModel, listModels } from '../translate/providers'
import type { FetchFn } from '../translate/http'
import type { TranslationPools } from '../translate/pool'
import { fakeProvider } from '../translate/fake'
import { withMockProviderUrl } from '../../shared/presets'

export type HandlerContext = {
  library: DocumentLibrary
  scheduler: Scheduler
  settings: SettingsStore
  secrets: SecretsStore
  pools: TranslationPools
  dialog: DialogHost
  fetch: FetchFn
  env: NodeJS.Dict<string>
  version: string
  platform: NodeJS.Platform
  arch: string
  logsDir: string
  getLibraryDir: () => string
  getTheme: () => 'system' | 'light' | 'dark'
  setTheme: (theme: 'system' | 'light' | 'dark') => Promise<void>
  checkUpdates: () => Promise<ChannelResponse<'app:checkUpdates'>>
  changeLibrary: (path: string) => Promise<string>
  reveal: (path: string) => void
  openPath: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  sendChanged: (item: ChannelResponse<'documents:get'>) => void
  sendRemoved: (id: string) => void
  relaunch: () => void
}

function running(ctx: HandlerContext): Set<string> {
  return ctx.scheduler.runningIds()
}

function view(ctx: HandlerContext) {
  return toSettingsView(ctx.settings.snapshot, ctx.secrets, ctx.env)
}

function resolveProvider(ctx: HandlerContext, id: string): ProviderConfig {
  const found = ctx.settings.snapshot.providers.find((item) => item.id === id)
  if (found) return withMockProviderUrl(found, ctx.env.DOCFLOW_MOCK_PROVIDER_URL)
  if (ctx.env.DOCFLOW_FAKE_PROVIDERS === '1' && id === 'fake') return fakeProvider()
  throw new UserError(ERROR_CODES.not_found, '找不到这个翻译服务商。')
}

export async function handleDocumentsCreate(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:create'>,
): Promise<ChannelResponse<'documents:create'>> {
  const provider = resolveProvider(ctx, req.translator.providerId)
  if (
    !provider.models.some((model) => model.id === req.translator.model) &&
    ctx.env.DOCFLOW_FAKE_PROVIDERS !== '1'
  ) {
    throw new UserError(ERROR_CODES.not_found, '找不到这个模型。')
  }
  const translator = {
    providerId: req.translator.providerId,
    model: req.translator.model,
    label: translatorLabel(provider, req.translator.model),
  }
  const created: ChannelResponse<'documents:create'>['created'] = []
  const failed: ChannelResponse<'documents:create'>['failed'] = []
  for (const path of req.paths) {
    try {
      const item = await ctx.library.create({
        path,
        translator,
        settingsSnapshot: ctx.settings.snapshot.translation,
        ...(req.title ? { title: req.title } : {}),
      })
      created.push(item)
      ctx.sendChanged(item)
    } catch (error) {
      failed.push({
        path,
        message: isUserError(error) ? error.message : '无法添加这个文件。',
      })
    }
  }
  await ctx.scheduler.tick()
  return { created, failed }
}

export function handleDocumentsList(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:list'>,
): ChannelResponse<'documents:list'> {
  return ctx.library.list(req.filter, req.query, running(ctx))
}

export function handleDocumentsGet(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:get'>,
): ChannelResponse<'documents:get'> {
  return ctx.library.get(req.id, ctx.scheduler.isRunning(req.id))
}

export async function handleDocumentsEvents(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:events'>,
): Promise<ChannelResponse<'documents:events'>> {
  ctx.library.require(req.id)
  return ctx.library.events.read(req.id, req.afterSeq ?? 0, req.limit ?? 500)
}

export async function handleDocumentsRename(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:rename'>,
): Promise<ChannelResponse<'documents:rename'>> {
  const renamed = await ctx.library.rename(req.id, req.title)
  const summary = ctx.library.get(renamed.id, ctx.scheduler.isRunning(renamed.id))
  ctx.sendChanged(summary)
  return summary
}

export async function handleDocumentsRetry(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:retry'>,
): Promise<ChannelResponse<'documents:retry'>> {
  const saved = await ctx.scheduler.retry(req.id, ctx.settings.snapshot.translation)
  const summary = ctx.library.get(saved.id, ctx.scheduler.isRunning(saved.id))
  ctx.sendChanged(summary)
  return summary
}

export async function handleDocumentsCancel(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:cancel'>,
): Promise<ChannelResponse<'documents:cancel'>> {
  const saved = await ctx.scheduler.cancel(req.id)
  const summary = ctx.library.get(saved.id, ctx.scheduler.isRunning(saved.id))
  ctx.sendChanged(summary)
  return summary
}

export async function handleDocumentsDelete(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:delete'>,
): Promise<ChannelResponse<'documents:delete'>> {
  const deleted: string[] = []
  for (const id of req.ids) {
    await ctx.scheduler.remove(id)
    ctx.sendRemoved(id)
    deleted.push(id)
  }
  return { deleted }
}

export async function handleDocumentsExport(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:export'>,
): Promise<ChannelResponse<'documents:export'>> {
  const summary = ctx.library.get(req.id, ctx.scheduler.isRunning(req.id))
  const names = summary.suggestedNames
  const e2ePath = ctx.env.DOCFLOW_E2E_SAVE_PATH
  if (req.kind === 'bundle') {
    const bytes = await exportBundle(ctx.library.dir, ctx.library.require(req.id))
    return saveExport({
      dialog: ctx.dialog,
      defaultPath: names.bundle,
      bytes,
      ...(e2ePath ? { e2ePath } : {}),
    })
  }
  const source = ctx.library.pathFor(req.id, req.kind)
  return saveExport({
    dialog: ctx.dialog,
    defaultPath: names[req.kind],
    sourcePath: source,
    ...(e2ePath ? { e2ePath } : {}),
  })
}

export function handleDocumentsReveal(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:reveal'>,
): ChannelResponse<'documents:reveal'> {
  if (!req.id) {
    ctx.reveal(ctx.getLibraryDir())
    return {}
  }
  ctx.reveal(ctx.library.pathFor(req.id, req.kind ?? 'folder'))
  return {}
}

export async function handleDocumentsOpenExternal(
  ctx: HandlerContext,
  req: ChannelRequest<'documents:openExternal'>,
): Promise<ChannelResponse<'documents:openExternal'>> {
  await ctx.openPath(ctx.library.pathFor(req.id, req.kind))
  return {}
}

export function handleAppInfo(ctx: HandlerContext): ChannelResponse<'app:info'> {
  return {
    version: ctx.version,
    platform: ctx.platform === 'win32' ? 'win32' : 'darwin',
    libraryDir: ctx.getLibraryDir(),
    logsDir: ctx.logsDir,
    arch: ctx.arch,
    theme: ctx.getTheme(),
    dataDirFromEnv: Boolean(ctx.env.DOCFLOW_DATA_DIR) && !ctx.env.DOCFLOW_E2E_FOLDER_PATH,
  }
}

export async function handleAppSetTheme(
  ctx: HandlerContext,
  req: ChannelRequest<'app:setTheme'>,
): Promise<ChannelResponse<'app:setTheme'>> {
  await ctx.setTheme(req.theme)
  return {}
}

export function handleSettingsGet(ctx: HandlerContext): ChannelResponse<'settings:get'> {
  return view(ctx)
}

export async function handleSettingsUpdate(
  ctx: HandlerContext,
  req: ChannelRequest<'settings:update'>,
): Promise<ChannelResponse<'settings:update'>> {
  await ctx.settings.update(req)
  ctx.pools.configure(ctx.settings.snapshot.providers)
  return view(ctx)
}

export async function handleSecretsSet(
  ctx: HandlerContext,
  req: ChannelRequest<'secrets:set'>,
): Promise<ChannelResponse<'secrets:set'>> {
  await ctx.secrets.set(req.providerId, req.value)
  ctx.pools.resetKeys(req.providerId)
  return view(ctx)
}

export async function handleProvidersSave(
  ctx: HandlerContext,
  req: ChannelRequest<'providers:save'>,
): Promise<ChannelResponse<'providers:save'>> {
  const provider = ProviderConfig.parse(req.provider)
  const list = [...ctx.settings.snapshot.providers]
  const index = list.findIndex((item) => item.id === provider.id)
  if (index >= 0) list[index] = provider
  else {
    if (list.length >= MAX_PROVIDERS) {
      throw new UserError(ERROR_CODES.internal, `最多添加 ${MAX_PROVIDERS} 个服务商。`, true)
    }
    list.push(provider)
  }
  await ctx.settings.replaceProviders(list)
  ctx.pools.configure(list)
  return view(ctx)
}

export async function handleProvidersDelete(
  ctx: HandlerContext,
  req: ChannelRequest<'providers:delete'>,
): Promise<ChannelResponse<'providers:delete'>> {
  const next = ctx.settings.snapshot.providers.filter((item) => item.id !== req.id)
  await ctx.settings.replaceProviders(next)
  await ctx.secrets.set(req.id, null).catch(() => undefined)
  ctx.pools.configure(next)
  return view(ctx)
}

function draftProvider(
  ctx: HandlerContext,
  req: { type: ProviderConfig['type']; baseUrl: string; providerId?: string },
): ProviderConfig {
  if (req.providerId) {
    const existing = ctx.settings.snapshot.providers.find((item) => item.id === req.providerId)
    if (existing) return { ...existing, type: req.type, baseUrl: req.baseUrl }
  }
  return ProviderConfig.parse({
    id: req.providerId ?? 'draft',
    name: 'draft',
    type: req.type,
    baseUrl: req.baseUrl,
    enabled: true,
    models: [],
    concurrency: 100,
  })
}

function draftFromRequest(
  ctx: HandlerContext,
  req: { type: ProviderConfig['type']; baseUrl: string; providerId?: string | undefined },
): ProviderConfig {
  const input: { type: ProviderConfig['type']; baseUrl: string; providerId?: string } = {
    type: req.type,
    baseUrl: req.baseUrl,
  }
  if (req.providerId) input.providerId = req.providerId
  return withMockProviderUrl(draftProvider(ctx, input), ctx.env.DOCFLOW_MOCK_PROVIDER_URL)
}

export async function handleProvidersListModels(
  ctx: HandlerContext,
  req: ChannelRequest<'providers:listModels'>,
): Promise<ChannelResponse<'providers:listModels'>> {
  const provider = draftFromRequest(ctx, req)
  const key = req.key ?? (req.providerId ? ctx.secrets.get(req.providerId) : undefined)
  const models = await listModels(provider, key, ctx.fetch)
  return { models }
}

export async function handleProvidersCheck(
  ctx: HandlerContext,
  req: ChannelRequest<'providers:check'>,
): Promise<ChannelResponse<'providers:check'>> {
  const provider = draftFromRequest(ctx, req)
  const key = req.key ?? (req.providerId ? ctx.secrets.get(req.providerId) : undefined)
  return checkModel(provider, key, req.model, ctx.fetch, ctx.version)
}

export async function handleDialogPickPdfs(
  ctx: HandlerContext,
): Promise<ChannelResponse<'dialog:pickPdfs'>> {
  return pickPdfs(ctx.dialog)
}

export async function handleDialogPickFolder(
  ctx: HandlerContext,
  req: ChannelRequest<'dialog:pickFolder'>,
): Promise<ChannelResponse<'dialog:pickFolder'>> {
  const e2e = ctx.env.DOCFLOW_E2E_FOLDER_PATH
  if (e2e) return { path: e2e }
  return pickFolder(ctx.dialog, req.title, req.message)
}

export async function handleLibraryChange(
  ctx: HandlerContext,
  req: ChannelRequest<'library:change'>,
): Promise<ChannelResponse<'library:change'>> {
  const libraryDir = await ctx.changeLibrary(ensureLibraryFolderName(req.path))
  return { libraryDir }
}

export async function handleShellOpenExternal(
  ctx: HandlerContext,
  req: ChannelRequest<'shell:openExternal'>,
): Promise<ChannelResponse<'shell:openExternal'>> {
  if (!req.url.startsWith('https:') && !req.url.startsWith('mailto:')) {
    throw new UserError(ERROR_CODES.internal, '只能打开 https 或 mailto 链接。', true)
  }
  await ctx.openExternal(req.url)
  return {}
}

export async function handleShellOpenLogs(
  ctx: HandlerContext,
): Promise<ChannelResponse<'shell:openLogs'>> {
  await mkdir(ctx.logsDir, { recursive: true })
  await ctx.openPath(ctx.logsDir)
  return {}
}

export function handleAppRelaunch(ctx: HandlerContext): ChannelResponse<'app:relaunch'> {
  ctx.relaunch()
  return {}
}

export async function handleShellOpenNotices(
  ctx: HandlerContext,
): Promise<ChannelResponse<'shell:openNotices'>> {
  const candidates = [
    join(process.cwd(), 'THIRD_PARTY_NOTICES.md'),
    join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (found) await ctx.openPath(found)
  return {}
}
