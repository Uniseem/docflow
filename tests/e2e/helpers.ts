import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ChannelName, ChannelRequest, ChannelResponse } from '../../src/shared/ipc'
import type { DocumentSummary, ProcessingEvent } from '../../src/shared/types'
import { DEFAULT_MOCK_PORT, type MockConfig, type MockStats } from '../mock-provider/server'

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
export const MOCK_URL = `http://127.0.0.1:${DEFAULT_MOCK_PORT}`

export type DocumentStatus = DocumentSummary['status']

export function packedExecutable(): string {
  const candidates =
    process.platform === 'darwin'
      ? [
          join(repoRoot, 'release', 'mac-arm64', 'DocFlow.app', 'Contents', 'MacOS', 'DocFlow'),
          join(repoRoot, 'release', 'mac', 'DocFlow.app', 'Contents', 'MacOS', 'DocFlow'),
        ]
      : process.platform === 'win32'
        ? [join(repoRoot, 'release', 'win-unpacked', 'DocFlow.exe')]
        : [join(repoRoot, 'release', 'linux-unpacked', 'DocFlow')]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new Error(`未找到打包后的 DocFlow 可执行文件。已尝试：\n${candidates.join('\n')}`)
  }
  return found
}

export type LaunchOptions = {
  /** Library directory (DOCFLOW_DATA_DIR); defaults to the test's own temp directory. */
  dataDir?: string
  /** false: do not point the presets at the mock provider. */
  mock?: boolean
  extraEnv?: NodeJS.Dict<string>
}

export type Launched = { app: ElectronApplication; page: Page }

async function launchApp(options: LaunchOptions & { dataDir: string }): Promise<Launched> {
  const app = await electron.launch({
    executablePath: packedExecutable(),
    env: {
      ...process.env,
      DOCFLOW_DATA_DIR: options.dataDir,
      ...(options.mock === false ? {} : { DOCFLOW_MOCK_PROVIDER_URL: MOCK_URL }),
      ...options.extraEnv,
    },
  })
  const page = await app.firstWindow()
  // E2E_WINDOW=1000x700 reproduces the narrow layout of CI screens locally.
  const size = /^(\d+)x(\d+)$/.exec(process.env.E2E_WINDOW ?? '')
  if (size) {
    await app.evaluate(
      ({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0]?.setSize(bounds.width, bounds.height)
      },
      { width: Number(size[1]), height: Number(size[2]) },
    )
  }
  await expect(page).toHaveTitle('DocFlow')
  await page.waitForFunction(() => Boolean((globalThis as { docflow?: unknown }).docflow), null, {
    timeout: 15_000,
  })
  await expect(
    page.getByText(/全部文档|处理引擎未运行|DocFlow 用大模型翻译|把 PDF 拖到这里/).first(),
  ).toBeVisible({
    timeout: 20_000,
  })
  return { app, page }
}

/** Control of the shared mock provider started by global-setup.ts. */
export type MockControl = {
  /** Changes the delay / 429 cadence for the rest of the test (reset before every test). */
  configure: (config: Partial<MockConfig>) => Promise<void>
  stats: () => Promise<MockStats>
}

async function mockRequest(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${MOCK_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok)
    throw new Error(`mock ${path} 返回 ${response.status}：${await response.text()}`)
  return response.json()
}

const mockControl: MockControl = {
  configure: async (config) => {
    await mockRequest('/config', config)
  },
  stats: async () => (await mockRequest('/stats')) as MockStats,
}

type Fixtures = {
  /** Auto: the mock provider starts every test with fresh counters, no delay, 429 every 9th. */
  mockProvider: MockControl
  /** Makes a temp directory that is removed after the test. */
  tempDir: (prefix?: string) => string
  /** The test's default library directory (a fresh temp directory). */
  dataDir: string
  /** Launches the packed app; apps still running when the test ends are closed. */
  launch: (options?: LaunchOptions) => Promise<Launched>
}

export const test = base.extend<Fixtures>({
  mockProvider: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern
    async ({}, use) => {
      await mockRequest('/reset', {})
      await use(mockControl)
    },
    { auto: true },
  ],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern
  tempDir: async ({}, use, testInfo) => {
    const dirs: string[] = []
    await use((prefix = 'docflow-e2e-') => {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    })
    // Runs after `launch` has closed every app (fixtures tear down in reverse order).
    if (testInfo.status !== testInfo.expectedStatus) await attachLogs(testInfo, dirs)
    for (const dir of dirs) removeDir(dir)
  },
  dataDir: async ({ tempDir }, use) => {
    await use(tempDir())
  },
  launch: async ({ dataDir }, use) => {
    const apps: ElectronApplication[] = []
    await use(async (options = {}) => {
      const launched = await launchApp({ ...options, dataDir: options.dataDir ?? dataDir })
      apps.push(launched.app)
      return launched
    })
    for (const app of apps) await closeApp(app)
  },
})

/** Closes the app unless it already exited (tests may close it themselves). */
export async function closeApp(app: ElectronApplication): Promise<void> {
  let child: ReturnType<ElectronApplication['process']>
  try {
    child = app.process()
  } catch {
    return // Playwright throws once the application was closed through it
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  await app.close().catch(() => undefined)
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn(`无法删除 E2E 临时目录 ${dir}：${String(error)}`)
  }
}

/** Keeps the main-process logs of a failed test in its report before the directories go. */
async function attachLogs(testInfo: TestInfo, dirs: string[]): Promise<void> {
  const logs: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.electron-user-data') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name === 'main.log') logs.push(path)
    }
  }
  for (const dir of dirs) walk(dir, 0)
  for (const [index, path] of logs.entries()) {
    await testInfo.attach(`main-${index + 1}.log`, { path, contentType: 'text/plain' })
  }
}

/** Calls `window.docflow.invoke` in the renderer; a rejection becomes an Error with its code. */
export async function invoke<K extends ChannelName>(
  page: Page,
  channel: K,
  payload: ChannelRequest<K>,
): Promise<ChannelResponse<K>> {
  const result = await page.evaluate(
    async ({ channel, payload }) => {
      const api = (
        globalThis as unknown as {
          docflow: { invoke: (channel: string, payload: unknown) => Promise<unknown> }
        }
      ).docflow
      try {
        return { ok: true as const, data: await api.invoke(channel, payload) }
      } catch (error) {
        // The preload rejects with a plain { code, message, user } object.
        const failure = error as { code?: unknown; message?: unknown }
        const code = typeof failure.code === 'string' ? failure.code : 'error'
        const message = typeof failure.message === 'string' ? failure.message : 'unknown'
        return { ok: false as const, error: `${code}：${message}` }
      }
    },
    { channel, payload },
  )
  if (!result.ok) throw new Error(`${channel} 失败（${result.error}）`)
  return result.data as ChannelResponse<K>
}

export function documentRows(page: Page) {
  return page.locator('[data-testid^="document-row-"]')
}

export function documentRow(page: Page, id: string) {
  return page.locator(`[data-testid="document-row-${id}"]`)
}

/**
 * Selects a document as a user would. Below 1100 px (CI screens) the detail is a modal drawer
 * that covers the list, so an open one is closed first; the click then opens it again.
 */
export async function openDocument(page: Page, id: string): Promise<void> {
  const drawer = page.locator('[data-slot="drawer-backdrop"]')
  if ((await drawer.count()) > 0) {
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
  }
  await documentRow(page, id).click()
}

export function getDocument(page: Page, id: string): Promise<DocumentSummary> {
  return invoke(page, 'documents:get', { id })
}

export async function documentEvents(
  page: Page,
  id: string,
  afterSeq = 0,
): Promise<ProcessingEvent[]> {
  const { items } = await invoke(page, 'documents:events', { id, afterSeq, limit: 5_000 })
  return items
}

/** Polls `documents:get` until `accept` holds; the error names the last state seen. */
export async function waitForDocument(
  page: Page,
  id: string,
  accept: (doc: DocumentSummary) => boolean,
  options: { timeout?: number; what?: string } = {},
): Promise<DocumentSummary> {
  const deadline = Date.now() + (options.timeout ?? 60_000)
  for (;;) {
    const doc = await getDocument(page, id)
    if (accept(doc)) return doc
    if (Date.now() > deadline) {
      throw new Error(`等待文档${options.what ? `「${options.what}」` : ''}超时：${describe(doc)}`)
    }
    await sleep(200)
  }
}

const TERMINAL: ReadonlySet<DocumentStatus> = new Set(['completed', 'failed', 'cancelled'])

/**
 * Waits until the document reaches `status`, then checks the library row shows the same
 * status. Once the document has been seen running, ending in another terminal state fails
 * at once (a terminal state seen before that may be the one a retry is about to leave).
 */
export async function waitForStatus(
  page: Page,
  id: string,
  status: DocumentStatus,
  timeout = 120_000,
): Promise<DocumentSummary> {
  let ran = false
  const doc = await waitForDocument(
    page,
    id,
    (item) => {
      if (item.status === status) return true
      if (!TERMINAL.has(item.status)) ran = true
      else if (ran && TERMINAL.has(status)) {
        throw new Error(`文档应为 ${status}，实际结束于 ${describe(item)}`)
      }
      return false
    },
    { timeout, what: status },
  )
  await expect(documentRow(page, id)).toHaveAttribute('data-status', status, { timeout: 10_000 })
  return doc
}

function describe(doc: DocumentSummary): string {
  const failure = doc.failure ? ` failure=${doc.failure.code}「${doc.failure.message}」` : ''
  return `status=${doc.status} stage=${doc.stage} progress=${doc.progress}${failure}`
}

/**
 * Serial, small batches: with a mock delay the translate stage of long.pdf (60 paragraphs)
 * takes ~30 requests, long enough to cancel or quit in the middle of it.
 */
export const SLOW_TRANSLATION = {
  perDocumentConcurrency: 1,
  llm: { maxSegmentsPerRequest: 2 },
} as const

export async function configureMockProvider(
  page: Page,
  options: { translation?: Record<string, unknown> } = {},
): Promise<void> {
  await invoke(page, 'providers:save', {
    provider: {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      enabled: true,
      models: [{ id: 'mock-chat' }],
      concurrency: 100,
      preset: 'deepseek',
    },
  })
  await invoke(page, 'secrets:set', { providerId: 'deepseek', value: 'test-key' })
  await invoke(page, 'settings:update', {
    defaultTranslator: { providerId: 'deepseek', model: 'mock-chat' },
    ...(options.translation ? { translation: options.translation } : {}),
  })
  await expect(page.getByText('把 PDF 拖到这里，或点按“新建翻译”。')).toBeVisible({
    timeout: 15_000,
  })
}

export async function createDocument(
  page: Page,
  path: string,
  extra?: { title?: string; model?: string },
): Promise<string> {
  const result = await invoke(page, 'documents:create', {
    paths: [path],
    translator: { providerId: 'deepseek', model: extra?.model ?? 'mock-chat' },
    ...(extra?.title ? { title: extra.title } : {}),
  })
  const id = result.created[0]?.id
  if (!id) {
    throw new Error(`documents:create 没有创建文档：${JSON.stringify(result.failed)}`)
  }
  await expect(documentRow(page, id)).toBeVisible({ timeout: 15_000 })
  return id
}

/** Number of translations the document's cache file holds on disk (0 when absent). */
export function cachedSegments(dataDir: string, id: string): number {
  const path = join(dataDir, 'documents', id, 'work', 'translation-cache.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Record<string, unknown> }
    return Object.keys(parsed.entries ?? {}).length
  } catch {
    return 0
  }
}

/** Fetches a URL in the main process (custom protocols included) and sums up the reply. */
export async function fetchInMain(
  app: ElectronApplication,
  url: string,
): Promise<{ status: number; type: string | null; magic: string; bytes: number }> {
  return app.evaluate(async ({ net }, target) => {
    const response = await net.fetch(target)
    const body = new Uint8Array(await response.arrayBuffer())
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      magic: String.fromCharCode(...body.subarray(0, 5)),
      bytes: body.byteLength,
    }
  }, url)
}

export const fixture = (name: string): string => join(repoRoot, 'tests', 'fixtures', name)

export { expect }
