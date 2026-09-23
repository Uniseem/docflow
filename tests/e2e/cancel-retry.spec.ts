import {
  configureMockProvider,
  createDocument,
  documentRows,
  expect,
  fixture,
  launchApp,
  tempDataDir,
  test,
  waitForStatus,
} from './helpers'

test('取消后重新处理会命中缓存', async () => {
  const dataDir = tempDataDir()
  const { app, page } = await launchApp({ dataDir })
  await configureMockProvider(page)
  await createDocument(page, fixture('long.pdf'))
  await documentRows(page).first().click()
  await expect(page.getByText(/处理中|排队中|分析版面|翻译/).first()).toBeVisible({
    timeout: 30_000,
  })
  await page.getByText('取消处理…').first().click()
  await page.getByText('取消处理', { exact: true }).click()
  await waitForStatus(page, 'cancelled', 30_000)
  await page.getByText('重新处理').first().click()
  await waitForStatus(page, 'completed')
  await page.getByText('处理记录').click()
  await expect(page.getByText(/缓存/).first()).toBeVisible()
  await app.close()
})
