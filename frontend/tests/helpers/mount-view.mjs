import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

// Install the DOM before loading Vue/Ant Design: runtime-dom captures document
// during import. These are real components, not stubs of the form or button.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'MutationObserver', 'localStorage', 'Event', 'MouseEvent', 'ShadowRoot']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
}
globalThis.getComputedStyle = (element) => dom.window.getComputedStyle(element)
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
dom.window.ResizeObserver = globalThis.ResizeObserver

const require = createRequire(import.meta.url)
const vue = require('vue')
const antd = require('ant-design-vue')
const icons = require('@ant-design/icons-vue')
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc')
const cache = new Map()

function transpile(source) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
}
function evaluate(source, dependencies) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', transpile(source))((name) => {
    assert.ok(name in dependencies, `unexpected component dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}
for (const file of ['processingModes', 'translationRuntime']) {
  cache.set(`../${file}`, evaluate(await readFile(new URL(`../../src/${file}.ts`, import.meta.url), 'utf8'), {}))
}
const apiModule = evaluate(await readFile(new URL('../../src/api.ts', import.meta.url), 'utf8'), {})
export const ApiError = apiModule.ApiError

export async function flush() {
  await vue.nextTick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await vue.nextTick()
}

export async function mountView(t, name, api) {
  const source = await readFile(new URL(`../../src/views/${name}.vue`, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename: `${name}.vue` })
  const script = compileScript(descriptor, { id: name })
  const template = compileTemplate({ source: descriptor.template.content, filename: `${name}.vue`, id: name, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const routes = []
  const dependencies = {
    vue, 'ant-design-vue': antd, '@ant-design/icons-vue': icons,
    'vue-router': { useRouter: () => ({ push: async (path) => { routes.push(path) } }) },
    '../api': { ...apiModule, api },
    '../components/DocumentCard.vue': { template: '<div />' },
    '../components/StatusChip.vue': { template: '<span />' },
    ...Object.fromEntries(cache),
  }
  const component = evaluate(script.content, dependencies).default
  component.render = evaluate(template.code, dependencies).render
  const host = document.createElement('div')
  document.body.append(host)
  const app = vue.createApp(component)
  app.use(antd.default)
  app.component('RouterLink', { props: ['to'], template: '<a :href="to"><slot /></a>' })
  app.mount(host)
  t.after(() => { app.unmount(); host.remove(); apiModule.clearAdminToken(); localStorage.clear() })
  await flush()
  return { host, routes }
}

export async function fill(input, value) {
  assert.ok(input, 'input must exist')
  input.value = value
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await flush()
}

export function button(host, label) {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent.replace(/\s/g, '') === label.replace(/\s/g, ''))
  assert.ok(found, `button not found: ${label}`)
  return found
}

export async function selectFile(host, name = 'paper.pdf') {
  const input = host.querySelector('input[type="file"]')
  assert.ok(input, 'real upload input must exist')
  const file = new dom.window.File(['%PDF-1.7\nUI test fixture'], name, { type: 'application/pdf' })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await flush()
  return file
}

export const publicConfig = {
  accepting_uploads: true, mineru_configured: true, translation_available: true,
  translation_tier: 2, google_configured: true, deepseek_configured: true,
  default_processing_mode: 'mineru', max_upload_mb: 200, accepted_extensions: ['.pdf', '.docx'],
  processing_modes: {
    mineru: { available: true, accepted_extensions: ['.pdf', '.docx'], native_pdf_only: false },
    pdf2zh: { available: true, accepted_extensions: ['.pdf'], native_pdf_only: true },
  },
}

export const runtime = {
  google: { concurrency: 32, chunk_chars: 3000, max_segments_per_request: 1 },
  deepseek: { concurrency: 64, chunk_chars: 6000, max_segments_per_request: 4 },
  per_document_concurrency: 4, system_prompt: '忠实翻译为中文。',
}
export const adminSettings = {
  mineru_configured: true, google_configured: true, deepseek_configured: true,
  mineru_model: 'vlm', deepseek_model: 'deepseek-v4-flash', translation_tier: 2,
  r2_account_id: '', r2_bucket: '', r2_public_base_url: '', r2_configured: false,
  translation_runtime: runtime, translation_runtime_defaults: runtime,
  translation_runtime_limits: {
    google: { concurrency_max: 256, chunk_chars_max: 4000, max_segments_per_request_max: 100 },
    deepseek: { concurrency_max: 2000, chunk_chars_max: 12000, max_segments_per_request_max: 64 },
    min_chunk_chars: 100, per_document_concurrency_max: 32, system_prompt_max_chars: 12000,
  },
}
