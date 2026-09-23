import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MOCK_PORT } from '../../tests/mock-provider/server'

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
export const MOCK_URL = `http://127.0.0.1:${DEFAULT_MOCK_PORT}`

type Bridge = {
  invoke: (channel: string, payload: unknown) => Promise<unknown>
}

function bridge(): Bridge {
  return (globalThis as unknown as { docflow: Bridge }).docflow
}

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

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'docflow-e2e-'))
}

export async function launchApp(options: {
  dataDir: string
  mock?: boolean
  extraEnv?: NodeJS.Dict<string>
}): Promise<{ app: ElectronApplication; page: Page }> {
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

export function documentRows(page: Page) {
  return page.locator('[data-testid^="document-row-"]')
}

export async function waitForStatus(
  page: Page,
  status: 'completed' | 'failed' | 'cancelled' | 'processing' | 'queued' | 'retrying',
  timeout = 120_000,
): Promise<void> {
  await expect(page.locator(`[data-status="${status}"]`).first()).toBeVisible({ timeout })
}

export async function configureMockProvider(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (globalThis as unknown as { docflow: Bridge }).docflow
    const provider = {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      enabled: true,
      models: [{ id: 'mock-chat' }],
      concurrency: 100,
      preset: 'deepseek',
    }
    await api.invoke('providers:save', { provider })
    await api.invoke('secrets:set', { providerId: 'deepseek', value: 'test-key' })
    await api.invoke('settings:update', {
      defaultTranslator: { providerId: 'deepseek', model: 'mock-chat' },
    })
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
  const result = await page.evaluate(
    async (input) => {
      const api = (globalThis as unknown as { docflow: Bridge }).docflow
      try {
        const created = (await api.invoke('documents:create', {
          paths: [input.path],
          translator: { providerId: 'deepseek', model: input.model ?? 'mock-chat' },
          ...(input.title ? { title: input.title } : {}),
        })) as { created: Array<{ id: string }>; failed: Array<{ path: string; message: string }> }
        const listed = (await api.invoke('documents:list', { filter: 'all' })) as {
          counts: { all: number }
          items: Array<{ id: string; title: string; status: string }>
        }
        return { ok: true as const, created, listed }
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error)
        return { ok: false as const, error: message }
      }
    },
    { path, title: extra?.title, model: extra?.model },
  )
  if (!result.ok) {
    throw new Error(`documents:create 失败：${result.error}`)
  }
  const id = result.created.created[0]?.id
  if (!id) {
    throw new Error(
      `documents:create 没有文档：${JSON.stringify({ failed: result.created.failed, listed: result.listed })}`,
    )
  }
  try {
    await expect
      .poll(async () => documentRows(page).count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
  } catch {
    throw new Error(
      `创建后列表没有出现行 id=${id} listed=${JSON.stringify({
        counts: result.listed.counts,
        items: result.listed.items,
      })}`,
    )
  }
  return id
}

export const fixture = (name: string): string => join(repoRoot, 'tests', 'fixtures', name)

export { test, expect, electron, bridge }
