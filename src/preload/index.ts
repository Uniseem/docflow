import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { PUSH_CHANNEL_NAMES, type DocflowApi } from '../shared/ipc'

const api: DocflowApi = {
  async invoke(channel, payload) {
    const result = (await ipcRenderer.invoke(channel, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string; user: boolean } }
    if (result && typeof result === 'object' && 'ok' in result) {
      if (!result.ok) {
        const error = new Error(result.error.message) as Error & { code: string; user: boolean }
        error.code = result.error.code
        error.user = result.error.user
        throw error
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
