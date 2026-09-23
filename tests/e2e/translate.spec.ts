import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('翻译 two-column 到完成、预览并导出', async () => {
  const dataDir = tempDataDir()
  const savePath = join(mkdtempSync(join(tmpdir(), 'df-export-')), 'out.pdf')
  const { app, page } = await launchApp({
    dataDir,
    extraEnv: { DOCFLOW_E2E_SAVE_PATH: savePath },
  })
  await configureMockProvider(page)
  await createDocument(page, fixture('two-column.pdf'))
  await waitForStatus(page, 'completed')
  await documentRows(page).first().click()
  await page.getByText('中文 PDF').click()
  await expect(page.locator('iframe[title="中文 PDF"]')).toBeVisible()
  await page.getByText('处理记录').click()
  await expect(page.getByText('校验通过').first()).toBeVisible()
  await page.getByText('导出', { exact: true }).click()
  await page.getByText('中文 PDF…').click()
  await expect(page.getByText(/已导出/).first()).toBeVisible({ timeout: 15_000 })
  await app.close()
})
