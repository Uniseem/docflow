import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/processingStages.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { processingStages, processingStageItems } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const document = { processing_mode: 'pdf2zh', status: 'processing', stage: 'pdf2zh_translation', progress: 50, translation_tier: 2, translate_requested: true, r2_mirror_status: 'pending' }

test('native PDF has the agreed five native stages followed by shared archive and publish stages', () => {
  const stages = processingStages(document)
  assert.deepEqual(stages.slice(1, 6).map((stage) => [stage.prefix, stage.start, stage.end]), [
    ['pdf2zh_preflight', 5, 9], ['pdf2zh_layout', 10, 29], ['pdf2zh_translation', 30, 79], ['pdf2zh_typesetting', 80, 89], ['pdf2zh_verified', 90, 93],
  ])
  assert.equal(stages.some((stage) => /MinerU|Markdown|WebP/.test(stage.title + stage.caption)), false)
  assert.deepEqual(stages.slice(6).map((stage) => [stage.title, stage.start, stage.end]), [['本地永久归档', 94, 98], ['镜像与发布', 99, 100]])
  assert.match(stages[3].caption, /DeepSeek 非思考/)
})

test('native stage prefixes select the active step, including detailed worker substeps', () => {
  const items = processingStageItems({ ...document, stage: 'pdf2zh_typesetting_page_completed', progress: 79 })
  assert.deepEqual(items.map((item) => item.status), ['finish', 'finish', 'finish', 'finish', 'process', 'wait', 'wait', 'wait'])
})

test('failed native tasks mark the current native phase without changing later phases', () => {
  assert.deepEqual(processingStageItems({ ...document, status: 'failed', stage: 'failed' }).map((item) => item.status), ['finish', 'finish', 'finish', 'error', 'wait', 'wait', 'wait', 'wait'])
  assert.equal(processingStageItems({ ...document, status: 'failed', stage: 'pdf2zh_preflight_rejected' })[1].status, 'error')
})

test('native queued, archival, publishing and completed states retain common progress behavior', () => {
  assert.equal(processingStageItems({ ...document, status: 'queued', stage: 'queued', progress: 0 })[0].status, 'process')
  assert.equal(processingStageItems({ ...document, stage: 'local_archive_starting', progress: 94 })[6].status, 'process')
  assert.equal(processingStageItems({ ...document, stage: 'r2_mirror_starting', progress: 99 })[7].status, 'process')
  assert.equal(processingStageItems({ ...document, status: 'completed', stage: 'completed', progress: 100 }).every((item) => item.status === 'finish'), true)
})

test('MinerU and legacy tasks keep their original stage order and progress ranges', () => {
  const mineru = { ...document, processing_mode: 'mineru', stage: 'mineru_running', progress: 40 }
  assert.deepEqual(processingStages(mineru).map((stage) => [stage.title, stage.start, stage.end]), [
    ['接收与排队', 0, 4], ['MinerU 解析', 5, 52], ['获取结果', 53, 64], ['图片本地化', 65, 70], ['分段翻译', 71, 87], ['规范化与 PDF', 88, 93], ['本地永久归档', 94, 98], ['镜像与发布', 99, 100],
  ])
  assert.equal(processingStageItems(mineru)[1].status, 'process')
  assert.deepEqual(processingStages({ ...mineru, processing_mode: undefined }), processingStages(mineru))
  assert.equal(processingStages({ ...mineru, translate_requested: false })[4].title, '翻译（已跳过）')
})
