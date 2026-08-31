import type {
  AdminSettings,
  AdminStatus,
  DocumentDetail,
  DocumentList,
  DocumentSummary,
  ProcessingEventList,
  ProcessingMode,
  PublicConfig,
  TranslationRuntime,
} from './types'

const jsonHeaders = { 'Content-Type': 'application/json' }
const adminTokenKey = 'docflow-admin-token'
let memoryAdminToken = ''

// Login must still work when browser storage is disabled. The server also sets
// an HttpOnly cookie; localStorage is a best-effort bridge for older sessions.
export function readAdminToken(): string {
  try { return localStorage.getItem(adminTokenKey) || memoryAdminToken }
  catch { return memoryAdminToken }
}
export function saveAdminToken(token: string) {
  memoryAdminToken = token
  try { localStorage.setItem(adminTokenKey, token) } catch { /* Cookie + memory remain usable. */ }
}
export function clearAdminToken() {
  memoryAdminToken = ''
  try { localStorage.removeItem(adminTokenKey) } catch { /* Storage may be disabled. */ }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(path, { credentials: 'same-origin', signal: controller.signal, ...init })
    if (!response.ok) {
      let message = `请求失败（${response.status}）`
      try {
        const body = await response.json()
        if (typeof body.detail === 'string' && body.detail) message = body.detail
      } catch {
        // Keep the HTTP status fallback.
      }
      throw new ApiError(message, response.status)
    }
    if (response.status === 204) return undefined as T
    try { return await response.json() as T }
    catch { throw new ApiError('服务器返回了无效的数据，请刷新页面并确认前后端版本一致。', 502) }
  } catch (reason) {
    if (controller.signal.aborted) throw new ApiError('请求超时，请检查服务状态后重试。', 408)
    if (reason instanceof ApiError) throw reason
    throw new ApiError('无法连接服务器，请检查网络或稍后重试。', 0)
  } finally {
    clearTimeout(timer)
  }
}

function adminHeaders(): Record<string, string> {
  const token = readAdminToken()
  return token ? { ...jsonHeaders, Authorization: `Bearer ${token}` } : { ...jsonHeaders }
}

export const api = {
  publicConfig: () => request<PublicConfig>('/api/config/public'),
  listDocuments: (page = 1, pageSize = 12, query = '') =>
    request<DocumentList>(`/api/documents?page=${page}&page_size=${pageSize}&q=${encodeURIComponent(query)}`),
  getDocument: (id: string) => request<DocumentDetail>(`/api/documents/${id}`),
  getDocumentEvents: (id: string, afterId = 0) =>
    request<ProcessingEventList>(`/api/documents/${id}/events?after_id=${afterId}&limit=500`),
  adminStatus: () => request<AdminStatus>('/api/admin/status'),
  adminRegister: (username: string, password: string) =>
    request<{ token: string }>('/api/admin/register', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ username, password }),
    }),
  adminLogin: (username: string, password: string) =>
    request<{ token: string }>('/api/admin/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ username, password }),
    }),
  ensureAdminSession: () => request<void>('/api/admin/session', {
    method: 'POST',
    headers: adminHeaders(),
  }),
  adminLogout: () => request<void>('/api/admin/logout', { method: 'POST' }),
  adminSettings: () => request<AdminSettings>('/api/admin/settings', { headers: adminHeaders() }),
  adminListDocuments: (page = 1, pageSize = 100, query = '') =>
    request<DocumentList>(`/api/admin/documents?page=${page}&page_size=${pageSize}&q=${encodeURIComponent(query)}`, { headers: adminHeaders() }),
  saveMinerU: (apiKey: string, model: string) =>
    request<AdminSettings>('/api/admin/settings/mineru', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ api_key: apiKey, model }),
    }),
  saveGoogle: (apiKey: string) =>
    request<AdminSettings>('/api/admin/settings/google', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ api_key: apiKey }),
    }),
  saveDeepSeek: (apiKey: string, model: string) =>
    request<AdminSettings>('/api/admin/settings/deepseek', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ api_key: apiKey, model }),
    }),
  saveTranslationTier: (tier: 1 | 2 | 3) =>
    request<AdminSettings>('/api/admin/settings/translation', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ tier }),
    }),
  saveTranslationRuntime: (runtime: TranslationRuntime) =>
    request<AdminSettings>('/api/admin/settings/translation-runtime', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify(runtime),
    }),
  saveR2: (accountId: string, accessKeyId: string, secretAccessKey: string, bucket: string, publicBaseUrl: string) =>
    request<AdminSettings>('/api/admin/settings/r2', {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ account_id: accountId, access_key_id: accessKeyId, secret_access_key: secretAccessKey, bucket, public_base_url: publicBaseUrl }),
    }),
  updateDocumentNames: (id: string, title: string, displayFilename: string) =>
    request<DocumentSummary>(`/api/admin/documents/${id}/names`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ title, display_filename: displayFilename }),
    }),
  updateDocumentVisibility: (id: string, isPublic: boolean) =>
    request<DocumentSummary>(`/api/admin/documents/${id}/visibility`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ is_public: isPublic }),
    }),
  retryDocument: (id: string) =>
    request<DocumentSummary>(`/api/admin/documents/${id}/retry`, {
      method: 'POST',
      headers: adminHeaders(),
    }),
  streamDocumentEvents: (id: string, afterId: number, onEvent: (event: import('./types').ProcessingEvent) => void, onEnd: () => void, onError: () => void, onOpen?: () => void) => {
    const source = new EventSource(`/api/v1/jobs/${id}/events/stream?after_id=${afterId}`)
    let closed = false
    const fail = () => { if (closed) return; closed = true; source.close(); onError() }
    source.onopen = () => { if (!closed) onOpen?.() }
    source.addEventListener('progress', (message) => {
      if (closed) return
      let event: import('./types').ProcessingEvent
      try { event = JSON.parse((message as MessageEvent).data) as import('./types').ProcessingEvent }
      catch { fail(); return }
      onEvent(event)
    })
    source.addEventListener('end', () => { if (closed) return; closed = true; source.close(); onEnd() })
    source.onerror = fail
    return () => { closed = true; source.close() }
  },
  uploadDocument: (file: File, title: string, translationTier: 1 | 2 | 3, processingMode: ProcessingMode, onProgress: (percent: number) => void) =>
    new Promise<DocumentSummary>((resolve, reject) => {
      const form = new FormData()
      form.append('file', file)
      if (title.trim()) form.append('title', title.trim())
      form.append('translation_tier', String(translationTier))
      form.append('processing_mode', processingMode)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/v1/jobs')
      xhr.withCredentials = true
      xhr.responseType = 'json'
      xhr.timeout = 15 * 60 * 1000
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (typeof xhr.response?.id === 'string' && xhr.response.id.trim()) resolve(xhr.response as DocumentSummary)
          else reject(new Error('服务器未返回有效的任务编号，请刷新页面并检查后台任务，避免重复提交。'))
        }
        else reject(new Error(xhr.response?.detail || `上传失败（${xhr.status}）`))
      }
      xhr.onerror = () => reject(new Error('网络连接中断，请稍后重试'))
      xhr.ontimeout = () => reject(new Error('提交超时，请检查网络和后台任务后重试，避免重复上传。'))
      xhr.onabort = () => reject(new Error('文件提交已中断，请重新提交。'))
      xhr.send(form)
    }),
}
