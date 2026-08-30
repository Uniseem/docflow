import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const source = await readFile(new URL('../src/views/HomeView.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source, { filename: 'HomeView.vue' })
const script = compileScript(descriptor, { id: 'home-upload-test' })
const compiled = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const modesSource = await readFile(new URL('../src/processingModes.ts', import.meta.url), 'utf8')
const modesCompiled = ts.transpileModule(modesSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const modes = await import(`data:text/javascript;base64,${Buffer.from(modesCompiled).toString('base64')}`)

function createHome(t, initialConfig) {
  let currentConfig = initialConfig
  const uploads = []
  const routes = []
  const api = {
    publicConfig: async () => currentConfig,
    uploadDocument: async (file, title, tier, mode, onProgress) => {
      uploads.push({ file, title, tier, mode })
      onProgress(100)
      return { id: 'created-job' }
    },
  }
  const dependencies = {
    // Exercise the actual setup script and Vue reactivity without a browser or network.
    vue: { ...vue, onMounted() {}, onBeforeUnmount() {} },
    'vue-router': { useRouter: () => ({ push: async (route) => { routes.push(route) } }) },
    '@ant-design/icons-vue': {},
    '../api': { api },
    '../components/DocumentCard.vue': {},
    '../processingModes': modes,
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(name in dependencies, `unexpected module dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  const scope = vue.effectScope()
  const state = scope.run(() => module.exports.default.setup({}, { expose() {} }))
  t.after(() => scope.stop())
  return { state, uploads, routes, setConfig: (value) => { currentConfig = value } }
}

function config(mineruAvailable = true) {
  return {
    accepting_uploads: mineruAvailable,
    mineru_configured: mineruAvailable,
    translation_available: true,
    translation_tier: 2,
    google_configured: true,
    deepseek_configured: true,
    default_processing_mode: 'mineru',
    max_upload_mb: 200,
    accepted_extensions: ['.pdf', '.docx'],
    processing_modes: {
      mineru: { available: mineruAvailable, accepted_extensions: ['.pdf', '.docx'], native_pdf_only: false },
      pdf2zh: { available: true, accepted_extensions: ['.pdf'], native_pdf_only: true },
    },
  }
}

test('Home can submit native PDF with MinerU absent using the same selected translation tier', async (t) => {
  const { state, uploads, routes } = createHome(t, config(false))
  await state.loadConfig()
  assert.equal(state.selectedProcessingMode.value, 'pdf2zh')
  assert.equal(state.selectedTranslationTier.value, 2)
  assert.equal(state.unavailableReason.value, '')
  const file = new File(['pdf'], '论文.pdf')
  state.chooseFile(file)
  assert.equal(state.canSubmit.value, true)
  await state.submit()
  assert.deepEqual(uploads, [{ file, title: '论文', tier: 2, mode: 'pdf2zh' }])
  assert.deepEqual(routes, ['/documents/created-job'])
  assert.equal(state.uploadProgress.value, 100)
  assert.equal(state.uploading.value, false)
})

test('Home mode switching invalidates an already-selected non-PDF before submission', async (t) => {
  const { state, uploads } = createHome(t, config())
  await state.loadConfig()
  const file = new File(['office'], '报告.docx')
  state.chooseFile(file)
  assert.equal(state.canSubmit.value, true)
  state.selectedProcessingMode.value = 'pdf2zh'
  await vue.nextTick()
  assert.deepEqual(state.allowedExtensions.value, ['.pdf'])
  assert.match(state.fileValidation.value, /仅支持 \.pdf/)
  assert.equal(state.canSubmit.value, false)
  await state.submit()
  assert.deepEqual(uploads, [])
  assert.equal(state.file.value, file)
  state.selectedProcessingMode.value = 'mineru'
  assert.equal(state.fileValidation.value, '')
  assert.equal(state.canSubmit.value, true)
})

test('Home keeps the shared tier and edited title when switching processing modes', async (t) => {
  const { state, uploads } = createHome(t, config())
  await state.loadConfig()
  state.selectedTranslationTier.value = 3
  state.chooseFile(new File(['office'], 'first.docx'))
  state.title.value = '自定义中文标题'
  state.selectedProcessingMode.value = 'pdf2zh'
  state.chooseFile(new File(['pdf'], 'second.pdf'))
  assert.equal(state.title.value, '自定义中文标题')
  assert.equal(state.selectedTranslationTier.value, 3)
  assert.equal(state.canSubmit.value, true)
  await state.submit()
  assert.equal(uploads[0].tier, 3)
  assert.equal(uploads[0].mode, 'pdf2zh')
})

test('Home revalidates file limits and provider availability when public config refreshes', async (t) => {
  const value = config()
  const { state, uploads, setConfig } = createHome(t, value)
  await state.loadConfig()
  state.selectedProcessingMode.value = 'pdf2zh'
  state.chooseFile(new File([new Uint8Array(1048577)], 'paper.pdf'))
  assert.equal(state.canSubmit.value, true)
  setConfig({ ...value, max_upload_mb: 1 })
  await state.loadConfig()
  assert.equal(state.selectedProcessingMode.value, 'pdf2zh')
  assert.match(state.fileValidation.value, /不能超过 1 MB/)
  assert.equal(state.canSubmit.value, false)
  await state.submit()
  assert.deepEqual(uploads, [])
  setConfig({ ...value, google_configured: false, deepseek_configured: false })
  await state.loadConfig()
  assert.equal(state.canSubmit.value, false)
})

test('Home prevents uploads until config is loaded and preserves the current file during an in-flight upload', async (t) => {
  const { state } = createHome(t, config())
  state.chooseFile(new File(['pdf'], 'first.pdf'))
  assert.match(state.error.value, /读取服务配置/)
  assert.equal(state.file.value, null)
  assert.equal(state.canSubmit.value, false)
  await state.loadConfig()
  const selected = new File(['pdf'], 'first.pdf')
  state.chooseFile(selected)
  state.uploading.value = true
  state.chooseFile(new File(['pdf'], 'second.pdf'))
  assert.equal(state.file.value, selected)
  assert.equal(state.canSubmit.value, false)
})
