import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { SettingsView } from '../../src/shared/view'
import {
  configureMockProvider,
  createDocument,
  expect,
  fixture,
  invoke,
  test,
  waitForStatus,
} from './helpers'

const PROMPT = '自定义提示词用于测试持久化。'
const EXPECTED = { theme: 'dark', workers: 3, proxy: 'direct', prompt: PROMPT }

async function persisted(page: Page) {
  const settings = (await invoke(page, 'settings:get', {})) as SettingsView
  const info = await invoke(page, 'app:info', {})
  return {
    theme: info.theme,
    workers: settings.workerConcurrency,
    proxy: settings.proxy.mode,
    prompt: settings.translation.systemPrompt,
  }
}

async function openSettings(page: Page, tab: string): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}

test('设置在重启后保留，更换文档库后文档还在原位置', async ({ launch, tempDir }) => {
  // library:change appends /DocFlow unless the folder is already named DocFlow (05 章),
  // so the original library must be named DocFlow for "change back" to land on it again.
  const dataDir = join(tempDir(), 'DocFlow')
  const otherDir = tempDir('df-lib-')
  const env = { DOCFLOW_E2E_FOLDER_PATH: otherDir }

  const first = await launch({ dataDir, extraEnv: env })
  await configureMockProvider(first.page)
  const id = await createDocument(first.page, fixture('single-column.pdf'))
  await waitForStatus(first.page, id, 'completed')

  await openSettings(first.page, '通用')
  await first.page.getByText('深色', { exact: true }).click()
  const workers = first.page.getByRole('textbox', { name: '同时处理的文档数', exact: true })
  await workers.fill('3')
  await workers.press('Tab') // the number field commits on blur
  await first.page.getByRole('tab', { name: '网络', exact: true }).click()
  await first.page.getByText('不使用代理', { exact: true }).click()
  await first.page.getByRole('tab', { name: '高级', exact: true }).click()
  await first.page.getByRole('textbox', { name: '翻译提示词' }).fill(PROMPT)
  await first.page.getByRole('button', { name: '保存', exact: true }).click()
  // Every change above is an async IPC write: close only after the main process stored them.
  await expect.poll(() => persisted(first.page), { timeout: 10_000 }).toEqual(EXPECTED)
  await first.app.close()

  const second = await launch({ dataDir, extraEnv: env })
  expect(await persisted(second.page)).toEqual(EXPECTED)
  await openSettings(second.page, '通用')
  await expect(
    second.page.getByRole('textbox', { name: '同时处理的文档数', exact: true }),
  ).toHaveValue('3')

  await second.page.getByRole('button', { name: '更改…', exact: true }).click()
  await second.page
    .getByRole('alertdialog')
    .getByRole('button', { name: '更改', exact: true })
    .click()
  await expect
    .poll(async () => (await invoke(second.page, 'app:info', {})).libraryDir, { timeout: 20_000 })
    .toBe(join(otherDir, 'DocFlow'))
  expect((await invoke(second.page, 'documents:list', { filter: 'all' })).counts.all).toBe(0)
  await second.page.getByText('返回文档库').click()
  await expect(second.page.getByText(/把 PDF 拖到这里|先在设置中添加一个服务商/)).toBeVisible({
    timeout: 20_000,
  })

  await invoke(second.page, 'library:change', { path: dataDir })
  await waitForStatus(second.page, id, 'completed', 20_000)
  // Settings belong to the library, so the original ones come back with it.
  expect((await persisted(second.page)).workers).toBe(3)
})
