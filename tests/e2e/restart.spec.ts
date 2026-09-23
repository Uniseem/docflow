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

test('翻译进行中关闭后重启会从断点继续', async () => {
  const dataDir = tempDataDir()
  const first = await launchApp({ dataDir })
  await configureMockProvider(first.page)
  await createDocument(first.page, fixture('long.pdf'))
  await expect(first.page.locator('[data-testid^="document-row-"]').first()).toBeVisible({
    timeout: 30_000,
  })
  await first.app.close()

  const second = await launchApp({ dataDir })
  await waitForStatus(second.page, 'completed')
  await second.app.close()
})
