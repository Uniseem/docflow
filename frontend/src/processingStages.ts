import type { DocumentDetail } from './types'

interface ProcessingStage {
  title: string
  caption: string
  start: number
  end: number
  prefix?: string
}

type StepStatus = 'error' | 'finish' | 'process' | 'wait'

export function processingStages(document: DocumentDetail): ProcessingStage[] {
  const translationCaption = {
    1: 'Google Cloud · 共享任务池',
    2: 'DeepSeek 非思考 · 共享任务池',
    3: 'DeepSeek 思考 · 共享任务池',
  }[document.translation_tier] || '按任务所选档位处理'
  const native = document.processing_mode === 'pdf2zh'
  const stages: ProcessingStage[] = [
    { title: '接收与排队', caption: '上传、校验、PostgreSQL 入队', start: 0, end: 4 },
  ]
  if (native) {
    stages.push(
      { title: 'PDF 文本层检查', caption: '检查原生文本层，拒绝扫描件与加密文件', start: 5, end: 9, prefix: 'pdf2zh_preflight' },
      { title: 'PDF 版面分析', caption: 'BabelDOC 分析原文页面、段落与公式', start: 10, end: 29, prefix: 'pdf2zh_layout' },
      { title: 'PDF 原文翻译', caption: translationCaption, start: 30, end: 79, prefix: 'pdf2zh_translation' },
      { title: 'PDF 译文排版', caption: '保留页面版式，生成中文单语与双语 PDF', start: 80, end: 89, prefix: 'pdf2zh_typesetting' },
      { title: 'PDF 结果校验', caption: '检查单语、双语 PDF 的可读性与完整性', start: 90, end: 93, prefix: 'pdf2zh_verified' },
    )
  } else {
    stages.push(
      { title: 'MinerU 解析', caption: '上传、轮询与逐页状态', start: 5, end: 52 },
      { title: '获取结果', caption: '受限下载与安全解压 ZIP', start: 53, end: 64 },
      { title: '图片本地化', caption: 'WebP 转换、去重并改写本站路径', start: 65, end: 70 },
      { title: document.translate_requested ? '分段翻译' : '翻译（已跳过）', caption: document.translate_requested ? `${translationCaption}并发、无损校验与断点续跑` : '历史任务未启用翻译', start: 71, end: 87 },
      { title: '规范化与 PDF', caption: '公式、CommonMark、HTML 消毒与 PDF 生成', start: 88, end: 93 },
    )
  }
  stages.push(
    { title: '本地永久归档', caption: native ? '源 PDF、中文单语 PDF、双语 PDF 与清单' : '源文件、Markdown、PDF、HTML、WebP 与清单', start: 94, end: 98 },
    { title: '镜像与发布', caption: document.r2_mirror_status === 'archived' ? 'R2 镜像已校验，本地主副本保留' : 'R2 可选；本地归档直接发布', start: 99, end: 100 },
  )
  return stages
}

export function processingStageItems(document: DocumentDetail): { title: string; description: string; status: StepStatus }[] {
  const stages = processingStages(document)
  const activeIndex = stages.findIndex((stage) => stage.prefix && (document.stage === stage.prefix || document.stage.startsWith(`${stage.prefix}_`)))
  return stages.map((stage, index) => {
    let status: StepStatus
    if (document.status === 'completed') status = 'finish'
    else if (activeIndex >= 0) {
      // Native events can carry a specific substep; prefer it over coarse percent buckets.
      status = index < activeIndex ? 'finish' : index > activeIndex ? 'wait' : document.status === 'failed' ? 'error' : 'process'
    } else if (document.status === 'failed' && document.progress >= stage.start && document.progress <= stage.end) status = 'error'
    else if (document.progress > stage.end || (stage.end === 100 && document.progress === 100)) status = 'finish'
    else status = document.progress >= stage.start ? 'process' : 'wait'
    return { title: stage.title, description: `${stage.start}–${stage.end}% · ${stage.caption}`, status }
  })
}
