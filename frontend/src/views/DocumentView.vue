<script setup lang="ts">
import katex from 'katex'
import { Collapse as ACollapse, CollapsePanel as ACollapsePanel, Descriptions as ADescriptions, DescriptionsItem as ADescriptionsItem } from 'ant-design-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeftOutlined, DownloadOutlined, EyeOutlined, FileMarkdownOutlined, FilePdfOutlined, FileZipOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { api, readAdminToken } from '../api'
import ProcessingTimeline from '../components/ProcessingTimeline.vue'
import StageOverview from '../components/StageOverview.vue'
import StatusChip from '../components/StatusChip.vue'
import { documentDownloads, nativePdfPreviewUrl, processingModeLabel } from '../processingModes'
import type { DocumentDetail, ProcessingEvent } from '../types'

const route = useRoute()
const documentId = String(route.params.id)
const documentItem = ref<DocumentDetail | null>(null)
const events = ref<ProcessingEvent[]>([])
const eventTotal = ref(0)
const error = ref('')
const refreshing = ref(false)
const completionPending = ref(false)
const clock = ref(Date.now())
const connection = ref<'connecting' | 'live' | 'retrying' | 'closed'>('connecting')
let eventCursor = 0
let stopStream: (() => void) | undefined
let retryTimer: number | undefined
let refreshTimer: number | undefined
let clockTimer: number | undefined
let disposed = false

const latestEvent = computed(() => events.value.at(-1) || null)
const isLive = computed(() => Boolean(documentItem.value && !['completed', 'failed'].includes(documentItem.value.status)))
const isNativePdf = computed(() => documentItem.value?.processing_mode === 'pdf2zh')
const downloads = computed(() => documentDownloads(documentItem.value))
const pdfPreviewUrl = computed(() => nativePdfPreviewUrl(documentItem.value))
const downloadIcons = { markdown: FileMarkdownOutlined, pdf: FilePdfOutlined, bundle: FileZipOutlined }
const renderedMarkdownHtml = computed(() => documentItem.value?.content_html || '')
const workspaceState = computed(() => documentItem.value?.status === 'completed' ? 'completed' : 'processing')
const connectionText = computed(() => ({ connecting: '连接实时进度', live: '实时进度已连接', retrying: '连接中断，自动重连中', closed: '处理记录已保存' }[connection.value]))
const connectionStatus = computed(() => connection.value === 'retrying' ? 'warning' : connection.value === 'live' ? 'processing' : 'default')
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value))
const formatSize = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
const translationLabel = (tier: number) => ({ 1: '极速 · Google', 2: '均衡 · DeepSeek 非思考', 3: '精准 · DeepSeek 思考' }[tier] || `第 ${tier} 档`)
const archiveLabel = (status: string) => ({ pending: '等待归档', archived: '已归档', archiving: '正在归档', failed: '归档异常' }[status] || status)
const elapsedText = computed(() => {
  if (!documentItem.value) return ''
  const item = documentItem.value
  const end = item.completed_at ? new Date(item.completed_at).getTime() : item.status === 'failed' ? new Date(item.updated_at).getTime() : clock.value
  const seconds = Math.max(0, Math.round((end - new Date(item.created_at).getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`
})

async function renderMath() {
  await nextTick()
  if (disposed) return
  globalThis.document.querySelectorAll<HTMLElement>('[data-render-source="markdown"] .math-inline, [data-render-source="markdown"] .math-block').forEach((element) => {
    if (element.dataset.rendered) return
    try {
      katex.render(element.textContent || '', element, { displayMode: element.classList.contains('math-block'), throwOnError: false, trust: false })
      element.dataset.rendered = 'true'
    } catch { /* Keep source TeX readable if an individual formula fails. */ }
  })
}

async function loadEvents() {
  let more = true
  while (more && !disposed) {
    const response = await api.getDocumentEvents(documentId, eventCursor)
    if (disposed) return
    for (const event of response.items) appendEvent(event, false)
    eventTotal.value = response.total
    more = response.has_more
    if (!response.items.length) break
  }
}
function appendEvent(event: ProcessingEvent, refresh = true) {
  if (disposed || events.value.some((item) => item.id === event.id)) return
  events.value.push(event)
  events.value.sort((a, b) => a.id - b.id)
  eventCursor = Math.max(eventCursor, event.id)
  eventTotal.value = Math.max(eventTotal.value, events.value.length)
  // Historical events do not overwrite the newer authoritative job snapshot.
  if (refresh && documentItem.value) {
    documentItem.value.stage = event.stage
    documentItem.value.progress = event.progress
    if (event.stage === 'completed') completionPending.value = true
    else if (event.stage === 'failed') documentItem.value.status = 'failed'
    else if (event.stage === 'retrying') documentItem.value.status = 'retrying'
    else documentItem.value.status = 'processing'
  }
  if (refresh) scheduleRefresh(event.stage === 'completed' ? 0 : 350)
}
function scheduleRefresh(delay = 350) {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(async () => {
    try {
      const item = await api.getDocument(documentId)
      if (disposed) return
      documentItem.value = item
      if (item.status === 'completed' || item.status === 'failed') completionPending.value = false
      if (!isLive.value) connection.value = 'closed'
      if (item.status === 'completed') await renderMath()
      else if (completionPending.value) scheduleRefresh(750)
    } catch {
      // Keep the complete progress view visible instead of flashing an empty result.
      if (completionPending.value && !disposed) scheduleRefresh(1500)
    }
  }, delay)
}
function scheduleReconnect() {
  if (disposed) return
  connection.value = 'retrying'
  window.clearTimeout(retryTimer)
  retryTimer = window.setTimeout(async () => {
    await loadEvents().catch(() => undefined)
    try {
      const item = await api.getDocument(documentId)
      if (disposed) return
      documentItem.value = item
      if (item.status === 'completed') completionPending.value = false
      if (item.status === 'completed') await renderMath()
    } catch { /* Retry the stream while the API is temporarily unreachable. */ }
    connect()
  }, 2000)
}
function connect() {
  stopStream?.()
  if (disposed) return
  if (!isLive.value) { connection.value = 'closed'; return }
  connection.value = 'connecting'
  stopStream = api.streamDocumentEvents(documentId, eventCursor,
    (event) => { connection.value = 'live'; appendEvent(event) },
    async () => {
      if (disposed) return
      connection.value = 'closed'
      try {
        // The stream can finish before its last paged event batch is drained.
        await loadEvents()
        const item = await api.getDocument(documentId)
        if (disposed) return
        documentItem.value = item
        if (item.status === 'completed') completionPending.value = false
        await renderMath()
        if (isLive.value) scheduleReconnect()
      } catch { scheduleReconnect() }
    },
    scheduleReconnect,
    () => { if (!disposed) connection.value = 'live' },
  )
}
async function load() {
  if (refreshing.value) return
  refreshing.value = true; error.value = ''
  try {
    if (readAdminToken()) await api.ensureAdminSession().catch(() => undefined)
    const item = await api.getDocument(documentId)
    if (disposed) return
    documentItem.value = item
    if (item.status === 'completed') completionPending.value = false
    await loadEvents()
    if (item.status === 'completed') await renderMath()
    connect()
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法加载文档' }
  finally { refreshing.value = false }
}
onMounted(() => { void load(); clockTimer = window.setInterval(() => { clock.value = Date.now() }, 1000) })
onBeforeUnmount(() => { disposed = true; stopStream?.(); window.clearTimeout(retryTimer); window.clearTimeout(refreshTimer); window.clearInterval(clockTimer) })
</script>

<template>
  <div class="page-container">
    <router-link class="back-link" to="/library"><ArrowLeftOutlined /> 返回公开文库</router-link>
    <a-alert v-if="error" type="error" :message="error" show-icon class="section-gap"><template #action><a-button size="small" :loading="refreshing" @click="load">重试</a-button></template></a-alert>
    <div class="workspace-stage">
    <transition name="workspace-reveal">
      <div v-if="!documentItem && !error" key="loading" class="document-loading" aria-live="polite">
        <a-card class="document-summary section-gap"><a-skeleton active :paragraph="{ rows: 2 }" /></a-card>
        <div class="task-grid"><a-card><a-skeleton active :paragraph="{ rows: 6 }" /></a-card><a-card><a-skeleton active :paragraph="{ rows: 8 }" /></a-card></div>
        <span class="document-loading-label"><a-spin size="small" /> 正在载入任务与永久处理记录</span>
      </div>
      <div v-else-if="documentItem" key="workspace" class="document-workspace">
      <a-card class="document-summary section-gap">
        <a-space wrap class="section-gap">
          <StatusChip :status="documentItem.status" />
          <a-tag :color="documentItem.is_public ? 'blue' : 'default'">{{ documentItem.is_public ? '公开文档' : '私有文档' }}</a-tag>
          <a-tag :color="isNativePdf ? 'cyan' : 'default'">{{ processingModeLabel(documentItem.processing_mode) }}</a-tag>
          <a-tag v-if="documentItem.translated">{{ translationLabel(documentItem.translation_tier) }}</a-tag>
          <a-tag v-if="documentItem.local_archive_status === 'archived'">本地已归档</a-tag>
          <a-tag v-if="documentItem.r2_mirror_status === 'archived'">R2 已镜像</a-tag>
          <a-badge v-if="isLive" :status="connectionStatus" :text="connectionText" />
        </a-space>
        <h1 class="document-title">{{ documentItem.title }}</h1>
        <div class="document-meta"><span>{{ documentItem.display_filename }}</span><span>{{ formatSize(documentItem.source_size) }}</span><span>{{ formatDate(documentItem.created_at) }}</span><span v-if="!isNativePdf">{{ documentItem.image_count }} 张图片</span><span v-else-if="documentItem.pages_total != null">{{ documentItem.pages_total }} 页</span><span>{{ isLive ? '已运行' : '耗时' }} {{ elapsedText }}</span></div>
        <transition name="inline-feedback"><nav v-if="documentItem.status === 'completed'" class="document-actions" aria-label="文档下载">
          <a-button v-for="download in downloads" :key="download.key" :type="download.primary ? 'primary' : 'default'" :href="download.href"><template #icon><component :is="downloadIcons[download.kind]" /></template>{{ download.label }}</a-button>
        </nav></transition>
      </a-card>

      <div class="task-content-stage">
      <transition name="task-content" mode="out-in">
      <div v-if="workspaceState === 'completed'" key="completed" class="task-content-panel">
        <a-collapse class="section-gap">
          <a-collapse-panel key="audit" :header="`处理与归档记录 · ${eventTotal} 条事件`">
            <div class="task-grid"><a-card title="处理阶段" size="small"><StageOverview :document="documentItem" /></a-card><ProcessingTimeline :events="events" :total="eventTotal" :created-at="documentItem.created_at" /></div>
          </a-collapse-panel>
        </a-collapse>
        <a-card v-if="isNativePdf" title="PDF 翻译结果">
          <template #extra><a-tag>原版式 · BabelDOC</a-tag></template>
          <p class="section-description">本流程保留 PDF 页面版式，直接生成中文单语版与双语版，不生成 Markdown 正文。可在上方下载，也可主动打开中文 PDF 预览。</p>
          <a-space wrap>
            <a-button v-if="pdfPreviewUrl" :href="pdfPreviewUrl" target="_blank" rel="noopener noreferrer"><template #icon><EyeOutlined /></template>新窗口预览中文 PDF</a-button>
            <span v-if="documentItem.pdf_size != null" class="text-secondary">中文 PDF {{ formatSize(documentItem.pdf_size) }}</span>
            <span v-if="documentItem.dual_pdf_size != null" class="text-secondary">双语 PDF {{ formatSize(documentItem.dual_pdf_size) }}</span>
          </a-space>
        </a-card>
        <a-card v-else title="正文" class="markdown-card">
          <template #extra><a-tag>Markdown 渲染</a-tag></template>
          <article v-if="renderedMarkdownHtml" class="article-content" aria-label="Markdown 正文" data-render-source="markdown" v-html="renderedMarkdownHtml" />
          <a-empty v-else description="规范化 Markdown 正文暂不可用" />
        </a-card>
      </div>

      <div v-else key="processing" class="task-content-panel">
        <a-card class="section-gap">
          <div class="progress-heading"><h2>{{ completionPending ? '处理完成，正在打开结果' : documentItem.status === 'failed' ? '处理失败' : documentItem.status === 'retrying' ? '等待自动重试' : '处理进度' }}</h2><a-button :loading="refreshing" @click="load"><template #icon><ReloadOutlined /></template>刷新状态</a-button></div>
          <a-progress :percent="documentItem.progress" :status="documentItem.status === 'failed' ? 'exception' : 'active'" />
          <a-alert :type="documentItem.status === 'failed' ? 'error' : documentItem.status === 'retrying' ? 'warning' : 'info'" show-icon :message="completionPending ? '处理结果已生成，正在读取最终文件' : latestEvent?.message || documentItem.stage" class="current-event">
            <template #description><div v-if="latestEvent?.detail" class="event-detail">{{ latestEvent.detail }}</div><a-space wrap class="field-help"><span v-if="latestEvent">事件 #{{ latestEvent.id }}</span><span v-if="latestEvent?.current != null">当前 {{ latestEvent.current }}<template v-if="latestEvent.total !== null"> / {{ latestEvent.total }}</template></span><span>{{ documentItem.progress }} / 100</span></a-space></template>
          </a-alert>
          <a-alert v-if="documentItem.status === 'failed' && documentItem.failure_reason && documentItem.failure_reason !== latestEvent?.detail" type="error" :message="documentItem.failure_reason" show-icon class="section-top" />
        </a-card>
        <div class="task-grid">
          <div class="side-stack">
            <a-card title="处理阶段" size="small"><StageOverview :document="documentItem" /></a-card>
            <a-card title="任务信息" size="small">
              <a-descriptions :column="1" size="small">
                <a-descriptions-item label="处理方式">{{ processingModeLabel(documentItem.processing_mode) }}</a-descriptions-item>
                <a-descriptions-item label="翻译">{{ translationLabel(documentItem.translation_tier) }}</a-descriptions-item>
                <a-descriptions-item :label="isNativePdf ? '处理页数' : '解析页数'">{{ documentItem.pages_processed ?? '—' }} / {{ documentItem.pages_total ?? '—' }}</a-descriptions-item>
                <a-descriptions-item label="源文件">已永久保存</a-descriptions-item>
                <template v-if="isNativePdf">
                  <a-descriptions-item label="中文 PDF">{{ documentItem.pdf_variants_available?.mono ? '已生成' : '等待生成' }}</a-descriptions-item>
                  <a-descriptions-item label="双语 PDF">{{ documentItem.pdf_variants_available?.dual ? '已生成' : '等待生成' }}</a-descriptions-item>
                </template>
                <a-descriptions-item v-else label="PDF">{{ documentItem.pdf_available ? '已生成' : '等待生成' }}</a-descriptions-item>
                <a-descriptions-item label="本地归档">{{ archiveLabel(documentItem.local_archive_status) }}</a-descriptions-item>
              </a-descriptions>
              <a-space direction="vertical" class="full-width"><a-button :href="`/api/v1/jobs/${documentItem.id}/source`" block><template #icon><DownloadOutlined /></template>下载源文件</a-button><a-button :href="`/api/v1/jobs/${documentItem.id}/bundle`" block><template #icon><FileZipOutlined /></template>打包当前数据</a-button></a-space>
            </a-card>
          </div>
          <div class="side-stack"><ProcessingTimeline :events="events" :total="eventTotal" :created-at="documentItem.created_at" :live="isLive" /><a-alert type="info" show-icon message="离开页面不会中断任务" description="所有处理事件会永久写入数据库，失败时也会保留源文件与已有结果。" /></div>
        </div>
      </div>
      </transition>
      </div>
      </div>
    </transition>
    </div>
  </div>
</template>
