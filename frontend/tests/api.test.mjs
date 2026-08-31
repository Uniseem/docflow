import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { api, ApiError, readAdminToken, saveAdminToken, clearAdminToken } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function installStorage(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'test-admin-token' } })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage })
}

test('admin 401 responses preserve HTTP status for login expiration handling', async (t) => {
  installStorage(t)
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ detail: '登录已过期' }), { status: 401 }))
  await assert.rejects(api.adminSettings(), (error) => error instanceof ApiError && error.status === 401 && error.message === '登录已过期')
})

test('temporary failures retain distinct status instead of looking like expired login', async (t) => {
  installStorage(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('upstream temporarily unavailable', { status: 503 }))
  await assert.rejects(api.adminSettings(), (error) => error instanceof ApiError && error.status === 503 && error.message === '请求失败（503）')
})

test('runtime settings use the exact admin endpoint, bearer header and unwrapped JSON body', async (t) => {
  installStorage(t)
  const runtime = { google: { concurrency: 16, chunk_chars: 1000, max_segments_per_request: 3 }, deepseek: { concurrency: 32, chunk_chars: 2000, max_segments_per_request: 4 }, per_document_concurrency: 2, system_prompt: '忠实翻译全文。' }
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/admin/settings/translation-runtime')
    assert.equal(options.method, 'PUT')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.headers.Authorization, 'Bearer test-admin-token')
    assert.deepEqual(JSON.parse(options.body), runtime)
    return new Response(JSON.stringify({ translation_runtime: runtime }))
  })
  assert.deepEqual((await api.saveTranslationRuntime(runtime)).translation_runtime, runtime)
})

class MockEventSource {
  static latest
  listeners = new Map()
  closeCount = 0
  constructor(url) { this.url = url; MockEventSource.latest = this }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  close() { this.closeCount += 1 }
  emit(name, data) { this.listeners.get(name)?.({ data }) }
}
function installEventSource(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: MockEventSource })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor); else delete globalThis.EventSource })
}

test('event stream marks a live connection, forwards progress and closes once on end', (t) => {
  installEventSource(t)
  const received = []
  let opened = 0
  let ended = 0
  let failures = 0
  api.streamDocumentEvents('document-id', 12, (event) => received.push(event), () => { ended += 1 }, () => { failures += 1 }, () => { opened += 1 })
  const stream = MockEventSource.latest
  assert.equal(stream.url, '/api/v1/jobs/document-id/events/stream?after_id=12')
  stream.onopen()
  stream.emit('progress', JSON.stringify({ id: 13, stage: 'translation_batch_queued' }))
  stream.emit('end', 'complete')
  stream.onerror()
  assert.equal(opened, 1)
  assert.equal(ended, 1)
  assert.equal(failures, 0)
  assert.equal(stream.closeCount, 1)
  assert.deepEqual(received, [{ id: 13, stage: 'translation_batch_queued' }])
})

test('malformed SSE payloads trigger one controlled retry instead of an uncaught JSON exception', (t) => {
  installEventSource(t)
  let failures = 0
  api.streamDocumentEvents('document-id', 0, () => assert.fail('invalid payload forwarded'), () => assert.fail('not an end event'), () => { failures += 1 })
  const stream = MockEventSource.latest
  assert.doesNotThrow(() => stream.emit('progress', '{malformed'))
  stream.onerror()
  assert.equal(failures, 1)
  assert.equal(stream.closeCount, 1)
})

test('manual stream cleanup prevents stale callbacks after route changes', (t) => {
  installEventSource(t)
  const stop = api.streamDocumentEvents('document-id', 0, () => assert.fail('stale progress'), () => assert.fail('stale end'), () => assert.fail('stale retry'))
  const stream = MockEventSource.latest
  stop()
  stream.emit('progress', '{}')
  stream.emit('end', 'complete')
  stream.onerror()
  assert.equal(stream.closeCount, 1)
})

class MockXMLHttpRequest {
  static latest
  upload = {}
  constructor() { MockXMLHttpRequest.latest = this }
  open(method, url) { this.method = method; this.url = url }
  send(body) { this.body = body }
}
function installXMLHttpRequest(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: MockXMLHttpRequest })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'XMLHttpRequest', descriptor); else delete globalThis.XMLHttpRequest })
}

test('upload FormData sends the selected processing mode and shared tier for both flows', async (t) => {
  installXMLHttpRequest(t)
  for (const mode of ['mineru', 'pdf2zh']) {
    const file = new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' })
    const progress = []
    const uploaded = api.uploadDocument(file, '  中文论文  ', 3, mode, (value) => progress.push(value))
    const xhr = MockXMLHttpRequest.latest
    assert.equal(xhr.method, 'POST')
    assert.equal(xhr.url, '/api/v1/jobs')
    assert.equal(xhr.withCredentials, true)
    assert.equal(xhr.responseType, 'json')
    assert.ok(xhr.body instanceof FormData)
    assert.equal(xhr.body.get('file').name, 'paper.pdf')
    assert.equal(await xhr.body.get('file').text(), '%PDF-1.7')
    assert.equal(xhr.body.get('title'), '中文论文')
    assert.equal(xhr.body.get('translation_tier'), '3')
    assert.equal(xhr.body.get('processing_mode'), mode)
    assert.deepEqual([...xhr.body.keys()], ['file', 'title', 'translation_tier', 'processing_mode'])
    xhr.upload.onprogress({ lengthComputable: true, loaded: 7, total: 10 })
    xhr.upload.onprogress({ lengthComputable: false, loaded: 8, total: 0 })
    assert.deepEqual(progress, [70])
    xhr.status = 201
    xhr.response = { id: `${mode}-job`, processing_mode: mode }
    xhr.onload()
    assert.deepEqual(await uploaded, xhr.response)
  }
})

test('upload omits a blank title and surfaces native PDF validation failures', async (t) => {
  installXMLHttpRequest(t)
  const uploaded = api.uploadDocument(new File(['scan'], 'scan.pdf'), '  ', 1, 'pdf2zh', () => {})
  const xhr = MockXMLHttpRequest.latest
  assert.equal(xhr.body.has('title'), false)
  assert.equal(xhr.body.get('translation_tier'), '1')
  xhr.status = 422
  xhr.response = { detail: 'PDF 缺少文本层，请使用 MinerU 解析翻译。' }
  xhr.onload()
  await assert.rejects(uploaded, /PDF 缺少文本层/)
})

test('upload network errors remain actionable for either processing mode', async (t) => {
  installXMLHttpRequest(t)
  const uploaded = api.uploadDocument(new File(['pdf'], 'paper.pdf'), '', 2, 'pdf2zh', () => {})
  MockXMLHttpRequest.latest.onerror()
  await assert.rejects(uploaded, /网络连接中断/)
})

test('upload timeouts and aborts always reject instead of leaving the submit button pending forever', async (t) => {
  installXMLHttpRequest(t)
  for (const [event, message] of [['ontimeout', /提交超时/], ['onabort', /已中断/]]) {
    const pending = api.uploadDocument(new File(['pdf'], 'paper.pdf'), '', 1, 'mineru', () => {})
    const xhr = MockXMLHttpRequest.latest
    assert.equal(xhr.timeout, 900_000)
    xhr[event]()
    await assert.rejects(pending, message)
  }
})

test('a malformed successful upload response cannot navigate to an undefined document', async (t) => {
  installXMLHttpRequest(t)
  for (const response of [null, {}, { id: '' }, { id: 123 }]) {
    const pending = api.uploadDocument(new File(['pdf'], 'paper.pdf'), '', 1, 'mineru', () => {})
    const xhr = MockXMLHttpRequest.latest
    xhr.status = 200
    xhr.response = response
    xhr.onload()
    await assert.rejects(pending, /未返回有效的任务编号/)
  }
})

test('registration only sends username and password without any initialization secret', async (t) => {
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/admin/register')
    assert.deepEqual(JSON.parse(options.body), { username: 'test-admin', password: 'test-password-123' })
    assert.equal(options.headers.Authorization, undefined)
    return new Response(JSON.stringify({ token: 'fixture' }), { status: 201 })
  })
  assert.deepEqual(await api.adminRegister('test-admin', 'test-password-123'), { token: 'fixture' })
})

test('disabled browser storage still allows memory-backed login and cookie-only session restoration', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage disabled') } })
  t.after(() => { clearAdminToken(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage })
  assert.equal(readAdminToken(), '')
  saveAdminToken('memory-fixture-token')
  assert.equal(readAdminToken(), 'memory-fixture-token')
  let expected = 'Bearer memory-fixture-token'
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    assert.equal(options.headers.Authorization, expected)
    assert.equal(options.credentials, 'same-origin')
    return new Response(null, { status: 204 })
  })
  await api.ensureAdminSession()
  clearAdminToken()
  expected = undefined
  await api.ensureAdminSession()
})

test('unreachable API and invalid JSON responses display actionable connection errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(api.adminStatus(), (error) => error instanceof ApiError && error.status === 0 && /无法连接服务器/.test(error.message))
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>stale proxy response</html>'))
  await assert.rejects(api.adminStatus(), (error) => error instanceof ApiError && error.status === 502 && /无效的数据/.test(error.message))
})

test('a hung admin request times out with a retryable error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(globalThis, 'fetch', async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
  const pending = api.adminStatus()
  const rejected = assert.rejects(pending, (error) => error instanceof ApiError && error.status === 408 && /请求超时/.test(error.message))
  t.mock.timers.tick(60_000)
  await rejected
})

test('a response body that hangs after headers is still reported as a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(globalThis, 'fetch', async (_path, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))) },
  })))
  const pending = api.adminStatus()
  const rejected = assert.rejects(pending, (error) => error instanceof ApiError && error.status === 408)
  await Promise.resolve()
  t.mock.timers.tick(60_000)
  await rejected
})
