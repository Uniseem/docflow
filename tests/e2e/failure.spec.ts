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

test('encrypted / bad-key / missing-model 失败文案', async () => {
  const dataDir = tempDataDir()
  const { app, page } = await launchApp({ dataDir })
  await configureMockProvider(page)

  const encryptedId = await createDocument(page, fixture('encrypted.pdf'))
  await waitForStatus(page, 'failed', 60_000)
  await page.locator(`[data-testid="document-row-${encryptedId}"]`).click()
  await expect(page.getByText(/已加密/).first()).toBeVisible({ timeout: 15_000 })

  await page.evaluate(async () => {
    const api = (
      globalThis as unknown as { docflow: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).docflow
    await api.invoke('secrets:set', { providerId: 'deepseek', value: 'bad-key' })
  })
  const badId = await createDocument(page, fixture('single-column.pdf'), { title: 'bad-key' })
  await page.locator(`[data-testid="document-row-${badId}"]`).click()
  await expect(page.getByText(/API Key/).first()).toBeVisible({ timeout: 60_000 })

  await page.evaluate(async () => {
    const api = (
      globalThis as unknown as { docflow: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).docflow
    const settings = (await api.invoke('settings:get', {})) as {
      providers: Array<{
        id: string
        name: string
        type: 'openai'
        baseUrl: string
        enabled: boolean
        models: Array<{ id: string }>
        concurrency: number
        preset?: string
      }>
    }
    const provider = settings.providers.find((item) => item.id === 'deepseek')
    if (!provider) throw new Error('missing provider')
    await api.invoke('secrets:set', { providerId: 'deepseek', value: 'test-key' })
    // settings:get returns a view with read-only fields (keyConfigured, keyMasked…);
    // providers:save only accepts the config fields.
    const { id, name, type, baseUrl, enabled, concurrency, preset } = provider
    await api.invoke('providers:save', {
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
  })
  const missingId = await createDocument(page, fixture('single-column.pdf'), {
    title: 'missing-model',
    model: 'missing-model',
  })
  await page.locator(`[data-testid="document-row-${missingId}"]`).click()
  await expect(page.getByText(/模型/).first()).toBeVisible({ timeout: 60_000 })
  await app.close()
})
