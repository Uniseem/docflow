import { access } from 'node:fs/promises'
import { join } from 'node:path'
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

test('删除完成后的文档会从列表和目录消失', async () => {
  const dataDir = tempDataDir()
  const { app, page } = await launchApp({ dataDir })
  await configureMockProvider(page)
  const id = await createDocument(page, fixture('single-column.pdf'))
  await waitForStatus(page, 'completed')
  await documentRows(page).first().click()
  await page.getByLabel('更多').click()
  await page.getByText('删除…').click()
  await page.getByText('删除', { exact: true }).click()
  await expect(page.getByText('把 PDF 拖到这里，或点按“新建翻译”。')).toBeVisible({
    timeout: 15_000,
  })
  if (!id) throw new Error('missing document id')
  await expect(access(join(dataDir, 'documents', id))).rejects.toThrow()
  await app.close()
})
