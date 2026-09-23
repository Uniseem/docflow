import type { Page } from '@playwright/test'
import type { SettingsView } from '../../src/shared/view'
import { expect, invoke, test } from './helpers'

async function modelIds(page: Page): Promise<string[]> {
  const settings = (await invoke(page, 'settings:get', {})) as SettingsView
  return settings.providers[0]?.models.map((model) => model.id) ?? []
}

test('首次启动：空状态 → 添加 DeepSeek → 可用', async ({ launch }) => {
  const { page } = await launch()
  await expect(page.getByText('DocFlow 用大模型翻译。先在设置中添加一个服务商')).toBeVisible({
    timeout: 20_000,
  })
  await page.getByText('添加大模型服务商…').click()
  await expect(page.getByText('大模型服务商')).toBeVisible()
  await page.getByTestId('add-provider').getByText('添加服务商').click()
  await page.getByTestId('preset-deepseek').click()
  await page.getByPlaceholder('粘贴 API Key').fill('test-key')
  await page.getByText('保存', { exact: true }).click()
  await page.getByText('获取模型列表…').click()
  await expect(page.getByText('mock-chat').first()).toBeVisible({ timeout: 20_000 })
  await page.getByText('mock-chat').first().click()
  await page.getByText('确定', { exact: true }).click()
  // The pick is saved as exactly one model: no duplicate ids, nothing silently dropped.
  await expect.poll(() => modelIds(page), { timeout: 10_000 }).toEqual(['mock-chat'])
  // The mock provider was reset for this test, so this check is its first chat request and
  // can never land on the periodic 429.
  await page.getByRole('button', { name: '检查', exact: true }).click()
  await expect(page.getByText(/可用/).first()).toBeVisible({ timeout: 20_000 })
  const settings = (await invoke(page, 'settings:get', {})) as SettingsView
  expect(settings.capabilities.llmReady).toBe(true)
  await page.getByText('返回文档库').click()
  await expect(page.getByText('把 PDF 拖到这里，或点按“新建翻译”。')).toBeVisible()
})
