import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from '@cantoo/pdf-lib'
import type { Page } from '@playwright/test'
import type { SettingsView } from '../../src/shared/view'
import {
  configureMockProvider,
  createDocument,
  documentEvents,
  expect,
  fixture,
  invoke,
  openDocument,
  test,
  waitForStatus,
} from './helpers'

async function openAdvancedSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '高级', exact: true }).click()
}

async function pageSizes(path: string): Promise<Array<[number, number]>> {
  const doc = await PDFDocument.load(readFileSync(path))
  return doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())])
}

test('导入术语表、只翻译所选页、导出自动提取的术语表', async ({ launch, tempDir }) => {
  const dir = tempDir('df-glossary-')
  const csv = join(dir, '机器学习术语.csv')
  writeFileSync(csv, 'source,target\nlanguage model,语言模型\n')
  const savePath = join(dir, 'exported.csv')
  const dataDir = tempDir()
  const { page } = await launch({
    dataDir,
    extraEnv: { DOCFLOW_E2E_GLOSSARY_PATH: csv, DOCFLOW_E2E_SAVE_PATH: savePath },
  })
  await configureMockProvider(page)

  await openAdvancedSettings(page)
  await page.getByRole('button', { name: '导入 CSV…', exact: true }).click()
  await expect(page.getByText('机器学习术语', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('1 条', { exact: true })).toBeVisible()
  const settings = (await invoke(page, 'settings:get', {})) as SettingsView
  expect(settings.glossaries).toMatchObject([{ name: '机器学习术语', enabled: true, entries: 1 }])
  await page.getByText('返回文档库').click()

  const result = await invoke(page, 'documents:create', {
    paths: [fixture('two-column.pdf')],
    translator: { providerId: 'deepseek', model: 'mock-chat' },
    pages: '2-3',
    onlyTranslatedPages: true,
  })
  const id = result.created[0]?.id
  if (!id) throw new Error(JSON.stringify(result.failed))
  const done = await waitForStatus(page, id, 'completed')
  expect(done.files.glossary).toBeTruthy()

  // Only pages 2 and 3, and the bilingual PDF puts original and translation side by side.
  const output = join(dataDir, 'documents', id, 'output')
  expect(await pageSizes(join(output, 'mono.pdf'))).toEqual([
    [612, 792],
    [612, 792],
  ])
  expect(await pageSizes(join(output, 'dual.pdf'))).toEqual([
    [1224, 792],
    [1224, 792],
  ])

  await openDocument(page, id)
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.getByRole('menuitem', { name: '术语表（CSV）…' }).click()
  await expect(page.getByText(/已导出/).first()).toBeVisible({ timeout: 15_000 })
  // BabelDOC's auto_extracted_glossary CSV (utf-8-sig); the mock names one term.
  expect(readFileSync(savePath, 'utf8')).toBe('﻿source,target,tgt_lng\r\nattention,注意力,\r\n')
})

test('带 OCR 文字层的扫描件：默认提示去设置，打开后白底黑字翻译', async ({ launch }) => {
  const { page } = await launch()
  await configureMockProvider(page)
  const id = await createDocument(page, fixture('ocr-scan.pdf'))
  const failed = await waitForStatus(page, id, 'failed', 60_000)
  expect(failed.failure?.message).toMatch(/扫描件/)
  expect(failed.failure?.message).toMatch(/自动处理带文字层的扫描件/)

  await openAdvancedSettings(page)
  await page.getByText('自动处理带文字层的扫描件', { exact: true }).click()
  await expect
    .poll(async () => ((await invoke(page, 'settings:get', {})) as SettingsView).pdf.ocrWorkaround)
    .toBe(true)
  await page.getByText('返回文档库').click()

  await invoke(page, 'documents:retry', { id })
  await waitForStatus(page, id, 'completed', 120_000)
  const events = await documentEvents(page, id)
  expect(
    events.some((event) => event.message === '检测到扫描件（3 / 3 页）：译文用黑色写在白底上'),
  ).toBe(true)
})
