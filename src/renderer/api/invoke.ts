import type { z } from 'zod'
import type {
  ChannelName,
  ChannelRequest,
  ChannelResponse,
  PushChannelName,
  PushChannels,
} from '../../shared/ipc'
import { notify } from '../lib/notify'
import { toDocflowError } from './errors'

export function hasApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.docflow)
}

export async function invoke<K extends ChannelName>(
  channel: K,
  payload: ChannelRequest<K>,
): Promise<ChannelResponse<K>> {
  if (!window.docflow) {
    throw Object.assign(new Error('处理引擎未运行'), { code: 'internal', user: true })
  }
  try {
    return await window.docflow.invoke(channel, payload)
  } catch (raw) {
    const err = toDocflowError(raw)
    if (!err.user) {
      notify.danger('发生内部错误，详情见日志', {
        actionProps: {
          children: '打开日志',
          onPress: () => {
            void window.docflow.invoke('shell:openLogs', {})
          },
        },
      })
    }
    throw err
  }
}

export function listen<K extends PushChannelName>(
  channel: K,
  cb: (payload: z.output<(typeof PushChannels)[K]>) => void,
): () => void {
  if (!window.docflow) return () => undefined
  return window.docflow.on(channel, cb)
}
