const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.argv[2] || 'http://127.0.0.1:38100'
const outputDir = process.argv[3] || '/tmp/docflow-ui-qa'
const executablePath = process.env.CHROMIUM_PATH

const pageFilter = process.env.QA_PAGE
const profileFilter = process.env.QA_PROFILE
const fullPage = process.env.QA_FULL_PAGE !== 'false'

const pages = [
  { name: 'home', path: '/' },
  { name: 'library', path: '/library' },
  { name: 'admin', path: '/admin' },
  { name: 'article', path: '/documents/29399ad7-d885-438a-946c-ee93c99f2041' },
  { name: 'failed', path: '/documents/37a5cb14-d0e4-4500-a04a-c4e8c03d8c6f' },
].filter((target) => !pageFilter || target.name === pageFilter)

const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
].filter((viewport) => !profileFilter || viewport.name === profileFilter)

async function inspect(page) {
  return page.evaluate(() => {
    const root = document.documentElement
    const overflowing = [...document.querySelectorAll('body *')]
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className.slice(0, 160) : '',
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
        }
      })
      .filter((rect) => rect.left < -1 || rect.right > innerWidth + 1)
      .slice(0, 25)

    return {
      viewport: { innerWidth, innerHeight, devicePixelRatio },
      document: {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        scrollHeight: root.scrollHeight,
      },
      horizontalOverflow: root.scrollWidth > root.clientWidth,
      overflowing,
      brokenImages: [...document.images]
        .filter((image) => !image.complete || image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src),
      title: document.title,
    }
  })
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true })
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const results = []

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport })
      for (const target of pages) {
        const page = await context.newPage()
        const consoleErrors = []
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text())
        })
        page.on('pageerror', (error) => consoleErrors.push(error.message))
        const response = await page.goto(`${baseUrl}${target.path}`, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        })
        await page.evaluate(async () => {
          const images = [...document.images]
          images.forEach((image) => { image.loading = 'eager' })
          for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
            scrollTo(0, y)
            await new Promise((resolve) => setTimeout(resolve, 40))
          }
          scrollTo(0, 0)
        })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
        await page.waitForTimeout(500)
        const metrics = await inspect(page)
        const screenshot = path.join(outputDir, `${target.name}-${viewport.name}.png`)
        await page.screenshot({ path: screenshot, fullPage })
        results.push({
          page: target.name,
          path: target.path,
          profile: viewport.name,
          status: response?.status() || null,
          consoleErrors,
          screenshot,
          ...metrics,
        })
        await page.close()
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }

  const reportPath = path.join(outputDir, 'report.json')
  await fs.writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  if (results.some((result) => result.status !== 200 || result.horizontalOverflow || result.brokenImages.length || result.consoleErrors.length)) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
