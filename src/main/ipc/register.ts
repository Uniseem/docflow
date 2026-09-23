import { ipcMain } from 'electron'
import { ZodError } from 'zod'
import { isUserError } from '../../shared/errors'
import {
  channels,
  envelopeErr,
  envelopeOk,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
} from '../../shared/ipc'
import type { Logger } from '../log/logger'
import {
  handleAppInfo,
  handleAppSetTheme,
  handleAppRelaunch,
  handleDialogPickFolder,
  handleDialogPickPdfs,
  handleDocumentsCancel,
  handleDocumentsCreate,
  handleDocumentsDelete,
  handleDocumentsEvents,
  handleDocumentsExport,
  handleDocumentsGet,
  handleDocumentsList,
  handleDocumentsOpenExternal,
  handleDocumentsRename,
  handleDocumentsReveal,
  handleDocumentsRetry,
  handleLibraryChange,
  handleProvidersCheck,
  handleProvidersDelete,
  handleProvidersListModels,
  handleProvidersSave,
  handleSecretsSet,
  handleSettingsGet,
  handleSettingsUpdate,
  handleShellOpenExternal,
  handleShellOpenLogs,
  handleShellOpenNotices,
  type HandlerContext,
} from './handlers'

export type IpcHandlers = {
  [K in ChannelName]: (req: ChannelRequest<K>) => ChannelResponse<K> | Promise<ChannelResponse<K>>
}

export function createIpcHandlers(ctx: HandlerContext): IpcHandlers {
  return {
    'app:info': () => handleAppInfo(ctx),
    'app:setTheme': (req) => handleAppSetTheme(ctx, req),
    'app:checkUpdates': () => ctx.checkUpdates(),
    'app:relaunch': () => handleAppRelaunch(ctx),
    'settings:get': () => handleSettingsGet(ctx),
    'settings:update': (req) => handleSettingsUpdate(ctx, req),
    'secrets:set': (req) => handleSecretsSet(ctx, req),
    'providers:save': (req) => handleProvidersSave(ctx, req),
    'providers:delete': (req) => handleProvidersDelete(ctx, req),
    'providers:listModels': (req) => handleProvidersListModels(ctx, req),
    'providers:check': (req) => handleProvidersCheck(ctx, req),
    'documents:create': (req) => handleDocumentsCreate(ctx, req),
    'documents:list': (req) => handleDocumentsList(ctx, req),
    'documents:get': (req) => handleDocumentsGet(ctx, req),
    'documents:events': (req) => handleDocumentsEvents(ctx, req),
    'documents:rename': (req) => handleDocumentsRename(ctx, req),
    'documents:retry': (req) => handleDocumentsRetry(ctx, req),
    'documents:cancel': (req) => handleDocumentsCancel(ctx, req),
    'documents:delete': (req) => handleDocumentsDelete(ctx, req),
    'documents:export': (req) => handleDocumentsExport(ctx, req),
    'documents:reveal': (req) => handleDocumentsReveal(ctx, req),
    'documents:openExternal': (req) => handleDocumentsOpenExternal(ctx, req),
    'dialog:pickPdfs': () => handleDialogPickPdfs(ctx),
    'dialog:pickFolder': (req) => handleDialogPickFolder(ctx, req),
    'library:change': (req) => handleLibraryChange(ctx, req),
    'shell:openExternal': (req) => handleShellOpenExternal(ctx, req),
    'shell:openLogs': () => handleShellOpenLogs(ctx),
    'shell:openNotices': () => handleShellOpenNotices(ctx),
  }
}

export function registerIpc(handlers: IpcHandlers, logger: Logger): void {
  for (const name of Object.keys(channels) as ChannelName[]) {
    ipcMain.removeHandler(name)
    ipcMain.handle(name, async (_event, payload: unknown) => {
      try {
        const request = channels[name].request.parse(payload ?? {})
        const data = await handlers[name](request as never)
        if (process.env.NODE_ENV !== 'production') {
          channels[name].response.parse(data)
        }
        return envelopeOk(data)
      } catch (error) {
        if (isUserError(error)) {
          return envelopeErr(error.code, error.message, true)
        }
        if (error instanceof ZodError) {
          return envelopeErr('internal', '请求无效。', true)
        }
        logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        return envelopeErr('internal', '发生内部错误，详情见日志', false)
      }
    })
  }
}
