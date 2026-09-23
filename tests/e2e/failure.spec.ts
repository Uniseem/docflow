import type { SettingsView } from '../../src/shared/view'
import {
  configureMockProvider,
  createDocument,
  documentRow,
  expect,
  fixture,
  invoke,
  test,
  waitForStatus,
} from './helpers'

test('encrypted / bad-key / missing-model 失败文案', async ({ launch }) => {
  const { page } = await launch()
  await configureMockProvider(page)

  const encryptedId = await createDocument(page, fixture('encrypted.pdf'))
  const encrypted = await waitForStatus(page, encryptedId, 'failed', 60_000)
  expect(encrypted.failure?.message).toMatch(/已加密/)
  await documentRow(page, encryptedId).click()
  await expect(page.getByText(/已加密/).first()).toBeVisible({ timeout: 15_000 })

  await invoke(page, 'secrets:set', { providerId: 'deepseek', value: 'bad-key' })
  const badId = await createDocument(page, fixture('single-column.pdf'), { title: 'bad-key' })
  const bad = await waitForStatus(page, badId, 'failed', 60_000)
  expect(bad.failure?.message).toMatch(/API Key/)
  await documentRow(page, badId).click()
  await expect(page.getByText(/API Key/).first()).toBeVisible({ timeout: 15_000 })

  await invoke(page, 'secrets:set', { providerId: 'deepseek', value: 'test-key' })
  const settings = (await invoke(page, 'settings:get', {})) as SettingsView
  const provider = settings.providers.find((item) => item.id === 'deepseek')
  if (!provider) throw new Error('missing provider')
  // settings:get returns a view with read-only fields (keyConfigured, keyMasked…);
  // providers:save only accepts the config fields.
  const { id, name, type, baseUrl, enabled, concurrency, preset } = provider
  await invoke(page, 'providers:save', {
    provider: {
      id,
      name,
      type,
      baseUrl,
      enabled,
      concurrency,
      ...(preset ? { preset } : {}),
      models: [{ id: 'missing-model' }],
    },
  })
  const missingId = await createDocument(page, fixture('single-column.pdf'), {
    title: 'missing-model',
    model: 'missing-model',
  })
  const missing = await waitForStatus(page, missingId, 'failed', 60_000)
  expect(missing.failure?.message).toMatch(/模型/)
  await documentRow(page, missingId).click()
  await expect(page.getByText(/模型/).first()).toBeVisible({ timeout: 15_000 })
})
