import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import puppeteer from 'puppeteer-core'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: render.mjs INPUT_HTML OUTPUT_PDF')
}

const candidates = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
if (!executablePath) {
  throw new Error(`Chromium executable not found; checked: ${candidates.join(', ')}`)
}

const timeout = Number.parseInt(process.env.PDF_RENDER_TIMEOUT_MS || '180000', 10)
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-pdf-'))
const userDataDir = path.join(runtimeDir, 'profile')
const configDir = path.join(runtimeDir, 'config')
const cacheDir = path.join(runtimeDir, 'cache')
for (const directory of [userDataDir, configDir, cacheDir]) {
  fs.mkdirSync(directory, { recursive: true })
}
let browser
try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir,
    env: {
      ...process.env,
      HOME: runtimeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
    },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--allow-file-access-from-files',
      '--font-render-hinting=medium',
    ],
  })
  const page = await browser.newPage()
  page.on('pageerror', (error) => console.error(`PDF page error: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`PDF page ${message.type()}: ${message.text()}`)
    }
  })
  page.setDefaultTimeout(timeout)
  await page.goto(pathToFileURL(path.resolve(inputPath)).href, {
    waitUntil: 'load',
    timeout,
  })
  await page.waitForFunction(() => globalThis.__DOCFLOW_PDF_READY__ === true, { timeout })
  const title = await page.title()
  const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  await page.pdf({
    path: path.resolve(outputPath),
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    preferCSSPageSize: true,
    tagged: true,
    outline: true,
    margin: { top: '22mm', right: '20mm', bottom: '20mm', left: '20mm' },
    headerTemplate: `<div style="box-sizing:border-box;width:100%;margin:0 20mm;padding:0 0 2mm;border-bottom:.5px solid #aaa;color:#666;font-family:'Noto Sans CJK SC',sans-serif;font-size:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escape(title)}</div>`,
    footerTemplate: '<div style="box-sizing:border-box;width:100%;margin:0 20mm;padding:2mm 0 0;border-top:.5px solid #aaa;color:#666;font-family:serif;font-size:7px;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    timeout,
  })
} finally {
  try {
    if (browser) await browser.close()
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
}
