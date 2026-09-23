import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { PUSH_CHANNEL_NAMES, type DocflowApi, type IpcFailure } from '../shared/ipc'

const api: DocflowApi = {
  async invoke(channel, payload) {
    const result = (await ipcRenderer.invoke(channel, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string; user: boolean } }
    if (result && typeof result === 'object' && 'ok' in result) {
      if (!result.ok) {
        // contextBridge only keeps `message` of a thrown Error, so reject with a plain object;
        // renderer/api/invoke.ts turns it back into an Error that carries code and user.
        const failure: IpcFailure = {
          code: result.error.code,
          message: result.error.message,
          user: result.error.user,
        }
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw failure
      }
      return result.data as never
    }
    throw new Error('invalid ipc response')
  },
  on(channel, cb) {
    if (!PUSH_CHANNEL_NAMES.includes(channel)) return () => undefined
    const listener = (_event: unknown, payload: unknown) => {
      cb(structuredClone(payload) as never)
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  pathsForFiles(files) {
    return files.map((file) => webUtils.getPathForFile(file))
  },
}

contextBridge.exposeInMainWorld('docflow', api)
