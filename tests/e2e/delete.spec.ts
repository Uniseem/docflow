import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

test('删除完成后的文档会从列表和目录消失', async ({ launch, dataDir }) => {
  const { page } = await launch()
  await configureMockProvider(page)
  const id = await createDocument(page, fixture('single-column.pdf'))
  await waitForStatus(page, id, 'completed')
  const row = documentRow(page, id)
  await row.click()
  await row.getByLabel('更多').click()
  await page.getByRole('menuitem', { name: '删除…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('把 PDF 拖到这里，或点按“新建翻译”。')).toBeVisible({
    timeout: 15_000,
  })
  await expect(row).toHaveCount(0)
  expect(existsSync(join(dataDir, 'documents', id))).toBe(false)
  const listed = await invoke(page, 'documents:list', { filter: 'all' })
  expect(listed.counts.all).toBe(0)
})
