import {
  SLOW_TRANSLATION,
  cachedSegments,
  configureMockProvider,
  createDocument,
  documentEvents,
  expect,
  fixture,
  getDocument,
  test,
  waitForDocument,
  waitForStatus,
} from './helpers'

test('翻译进行中关闭后重启会从断点继续', async ({ launch, dataDir, mockProvider }) => {
  // Slow, serial requests keep long.pdf in the translate stage for ~15 s.
  // Layout detection of 60 pages takes minutes on a 2-core CI runner (worklog 2026-09-26).
  test.setTimeout(600_000)
  await mockProvider.configure({ delayMs: 500, rateLimitEvery: 0 })
  const first = await launch()
  await configureMockProvider(first.page, { translation: SLOW_TRANSLATION })
  const id = await createDocument(first.page, fixture('long.pdf'))
  await waitForDocument(first.page, id, (doc) => doc.stage === 'translate' && doc.progress > 30, {
    what: '翻译中',
    timeout: 420_000,
  })
  // Quit only after part of the translation reached the cache file, so the resumed run can
  // prove it did not pay for those paragraphs again.
  await expect.poll(() => cachedSegments(dataDir, id), { timeout: 20_000 }).toBeGreaterThan(0)
  expect(await getDocument(first.page, id)).toMatchObject({
    status: 'processing',
    stage: 'translate',
  })
  await first.app.close()

  await mockProvider.configure({ delayMs: 0 })
  const second = await launch()
  await waitForStatus(second.page, id, 'completed')
  const messages = (await documentEvents(second.page, id)).map((event) => event.message)
  expect(messages).toContain('应用重新启动，从断点继续')
  expect(messages.some((message) => /^缓存命中 \d+ 段$/.test(message))).toBe(true)
  // Quitting the app is not a cancel.
  expect(messages).not.toContain('已取消处理')
})
