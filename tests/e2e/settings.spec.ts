import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureMockProvider,
  createDocument,
  expect,
  fixture,
  launchApp,
  tempDataDir,
  test,
  waitForStatus,
} from './helpers'

test('设置在重启后保留，更换文档库后文档还在原位置', async () => {
  // library:change appends /DocFlow unless the folder is already named DocFlow (05 §library),
  // so the original library must be named DocFlow for "change back" to land on it again.
  const dataDir = join(tempDataDir(), 'DocFlow')
  const otherDir = mkdtempSync(join(tmpdir(), 'df-lib-'))
  const first = await launchApp({
    dataDir,
    extraEnv: { DOCFLOW_E2E_FOLDER_PATH: otherDir },
  })
  await configureMockProvider(first.page)
  await createDocument(first.page, fixture('single-column.pdf'))
  await waitForStatus(first.page, 'completed')
  await first.page.getByText('设置').click()
  await first.page.getByText('通用', { exact: true }).click()
  await first.page.getByText('深色', { exact: true }).click()
  await first.page.getByText('网络', { exact: true }).click()
  await first.page.getByText('不使用代理').click()
  await first.page.getByText('高级', { exact: true }).click()
  await first.page.getByRole('textbox').last().fill('自定义提示词用于测试持久化。')
  await first.page.getByText('保存', { exact: true }).click()
  await first.app.close()

  const second = await launchApp({
    dataDir,
    extraEnv: { DOCFLOW_E2E_FOLDER_PATH: otherDir },
  })
  const persisted = await second.page.evaluate(async () => {
    const api = (
      globalThis as unknown as { docflow: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).docflow
    const settings = (await api.invoke('settings:get', {})) as {
      proxy: { mode: string }
      translation: { systemPrompt: string }
    }
    const info = (await api.invoke('app:info', {})) as { theme: string }
    return {
      theme: info.theme,
      proxy: settings.proxy.mode,
      prompt: settings.translation.systemPrompt,
    }
  })
  expect(persisted.theme).toBe('dark')
  expect(persisted.proxy).toBe('direct')
  expect(persisted.prompt).toContain('自定义提示词用于测试持久化。')
  await second.page.getByText('设置').click()
  await second.page.getByText('通用', { exact: true }).click()
  await second.page.getByText('更改…').click()
  await second.page.getByText('更改', { exact: true }).click()
  await second.page.getByText('返回文档库').click()
  await expect(second.page.getByText(/把 PDF 拖到这里|先在设置中添加一个服务商/)).toBeVisible({
    timeout: 20_000,
  })
  await second.page.evaluate(async (path) => {
    const api = (
      globalThis as unknown as { docflow: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).docflow
    await api.invoke('library:change', { path })
  }, dataDir)
  await waitForStatus(second.page, 'completed', 20_000)
  await second.app.close()
})
