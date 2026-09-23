import {
  SLOW_TRANSLATION,
  cachedSegments,
  configureMockProvider,
  createDocument,
  documentEvents,
  openDocument,
  expect,
  fixture,
  test,
  waitForDocument,
  waitForStatus,
} from './helpers'

test('取消后重新处理会命中缓存', async ({ launch, dataDir, mockProvider }) => {
  // Slow, serial requests keep long.pdf in the translate stage for ~15 s.
  await mockProvider.configure({ delayMs: 500, rateLimitEvery: 0 })
  const { page } = await launch()
  await configureMockProvider(page, { translation: SLOW_TRANSLATION })
  const id = await createDocument(page, fixture('long.pdf'))
  await openDocument(page, id)

  // Cancel in the middle of the translate stage, once some translations are on disk.
  await waitForDocument(page, id, (doc) => doc.stage === 'translate' && doc.progress > 30, {
    what: '翻译中',
  })
  await expect.poll(() => cachedSegments(dataDir, id), { timeout: 20_000 }).toBeGreaterThan(0)
  await page.getByRole('button', { name: '取消处理…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '取消处理', exact: true }).click()
  const cancelled = await waitForStatus(page, id, 'cancelled', 30_000)
  expect(cancelled.stage).toBe('translate')
  const lastSeq = (await documentEvents(page, id)).at(-1)?.seq ?? 0

  await mockProvider.configure({ delayMs: 0 })
  await page.getByRole('button', { name: '重新处理', exact: true }).first().click()
  await waitForStatus(page, id, 'completed')
  const rerun = await documentEvents(page, id, lastSeq)
  expect(rerun.some((event) => /^缓存命中 \d+ 段$/.test(event.message))).toBe(true)
  const all = await documentEvents(page, id)
  expect(all.filter((event) => event.message === '已取消处理')).toHaveLength(1)
  await page.getByRole('tab', { name: '处理记录', exact: true }).click()
  await expect(page.getByText(/缓存命中/).first()).toBeVisible()
})
