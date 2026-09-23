import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  configureMockProvider,
  createDocument,
  documentRow,
  expect,
  fetchInMain,
  fixture,
  test,
  waitForStatus,
} from './helpers'

test('翻译 two-column 到完成、预览并导出', async ({ launch, tempDir }) => {
  const savePath = join(tempDir('df-export-'), 'out.pdf')
  const { app, page } = await launch({ extraEnv: { DOCFLOW_E2E_SAVE_PATH: savePath } })
  await configureMockProvider(page)
  const id = await createDocument(page, fixture('two-column.pdf'))
  await waitForStatus(page, id, 'completed')
  await documentRow(page, id).click()
  await page.getByRole('tab', { name: '中文 PDF', exact: true }).click()

  const preview = page.locator('iframe[title="中文 PDF"]')
  await expect(preview).toBeVisible()
  const src = (await preview.getAttribute('src')) ?? ''
  expect(src).toMatch(/^docflow:\/\/library\//)
  // The docflow:// handler itself must serve the PDF, not just leave an empty frame.
  const served = await fetchInMain(app, src.split('#')[0] ?? src)
  expect(served).toMatchObject({ status: 200, type: 'application/pdf', magic: '%PDF-' })
  expect(served.bytes).toBeGreaterThan(1_000)
  // The detail swaps in its fallback when the frame has not loaded after 5 s.
  await page.waitForTimeout(6_000)
  await expect(preview).toBeVisible()
  await expect(page.getByText(/无法在应用内预览/)).toHaveCount(0)

  await page.getByRole('tab', { name: '处理记录', exact: true }).click()
  await expect(page.getByText('校验通过').first()).toBeVisible()
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.getByRole('menuitem', { name: '中文 PDF…' }).click()
  await expect(page.getByText(/已导出/).first()).toBeVisible({ timeout: 15_000 })
  expect(readFileSync(savePath).subarray(0, 5).toString('latin1')).toBe('%PDF-')
})
