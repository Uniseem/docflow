<script setup lang="ts">
import katex from 'katex'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { api } from '../api'
import ProcessingTimeline from '../components/ProcessingTimeline.vue'
import StageOverview from '../components/StageOverview.vue'
import StatusChip from '../components/StatusChip.vue'
import type { DocumentDetail, ProcessingEvent } from '../types'

const route = useRoute()
const documentItem = ref<DocumentDetail | null>(null)
const events = ref<ProcessingEvent[]>([])
const eventTotal = ref(0)
const error = ref('')
const connection = ref<'connecting' | 'live' | 'retrying' | 'closed'>('connecting')

let eventCursor = 0
let stopStream: (() => void) | undefined
let retryTimer: number | undefined
let refreshTimer: number | undefined

const latestEvent = computed(() => events.value.at(-1) || null)
const isLive = computed(() => Boolean(documentItem.value && !['completed', 'failed'].includes(documentItem.value.status)))
const connectionText = computed(() => ({
  connecting: '正在连接实时进度',
  live: '实时进度已连接',
  retrying: '连接中断，正在重连',
  closed: '实时进度已结束',
}[connection.value]))

const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'long',
  timeStyle: 'medium',
  hour12: false,
}).format(new Date(value))

const formatSize = (bytes: number) => bytes < 1048576
  ? `${(bytes / 1024).toFixed(0)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`

function elapsedText() {
  if (!documentItem.value) return ''
  const end = documentItem.value.completed_at ? new Date(documentItem.value.completed_at) : new Date()
  const seconds = Math.max(0, Math.round((end.getTime() - new Date(documentItem.value.created_at).getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`
}

async function renderMath() {
  await nextTick()
  globalThis.document.querySelectorAll<HTMLElement>('.math-inline,.math-block').forEach((element) => {
    if (element.dataset.rendered) return
    try {
      katex.render(element.textContent || '', element, {
        displayMode: element.classList.contains('math-block'),
        throwOnError: false,
      })
      element.dataset.rendered = 'true'
    } catch {
      // Keep the source TeX visible when an individual formula cannot render.
    }
  })
}

async function loadEvents() {
  let more = true
  while (more) {
    const response = await api.getDocumentEvents(String(route.params.id), eventCursor)
    for (const event of response.items) appendEvent(event, false)
    eventTotal.value = response.total
    more = response.has_more
    if (!response.items.length) break
  }
}

function appendEvent(event: ProcessingEvent, refresh = true) {
  if (events.value.some((item) => item.id === event.id)) return
  events.value.push(event)
  events.value.sort((a, b) => a.id - b.id)
  eventCursor = Math.max(eventCursor, event.id)
  eventTotal.value = Math.max(eventTotal.value, events.value.length)

  if (documentItem.value) {
    documentItem.value.stage = event.stage
    documentItem.value.progress = event.progress
    if (event.stage === 'completed') documentItem.value.status = 'completed'
    else if (event.stage === 'failed') documentItem.value.status = 'failed'
    else if (event.stage === 'retrying') documentItem.value.status = 'retrying'
    else if (documentItem.value.status !== 'failed') documentItem.value.status = 'processing'
  }
  if (refresh) scheduleRefresh()
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(async () => {
    try {
      documentItem.value = await api.getDocument(String(route.params.id))
      if (documentItem.value.status === 'completed') await renderMath()
    } catch {
      // SSE continues to carry progress if this refresh request fails.
    }
  }, 500)
}

function connect() {
  stopStream?.()
  if (!isLive.value) {
    connection.value = 'closed'
    return
  }
  connection.value = 'connecting'
  stopStream = api.streamDocumentEvents(
    String(route.params.id),
    eventCursor,
    (event) => {
      connection.value = 'live'
      appendEvent(event)
    },
    async () => {
      connection.value = 'closed'
      documentItem.value = await api.getDocument(String(route.params.id))
      await renderMath()
    },
    () => {
      connection.value = 'retrying'
      retryTimer = window.setTimeout(async () => {
        await loadEvents().catch(() => undefined)
        scheduleRefresh()
        connect()
      }, 2000)
    },
  )
}

async function load() {
  try {
    if (localStorage.getItem('docflow-admin-token')) {
      await api.ensureAdminSession().catch(() => undefined)
    }
    documentItem.value = await api.getDocument(String(route.params.id))
    await loadEvents()
    if (documentItem.value.status === 'completed') await renderMath()
    else connect()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法加载文档'
  }
}

onMounted(load)
onBeforeUnmount(() => {
  stopStream?.()
  window.clearTimeout(retryTimer)
  window.clearTimeout(refreshTimer)
})
</script>

<template>
  <v-container v-if="error" class="state-page">
    <v-alert type="error" variant="tonal">{{ error }}</v-alert>
    <v-btn to="/library" variant="text" prepend-icon="mdi-arrow-left" class="mt-4">返回文库</v-btn>
  </v-container>

  <v-container v-else-if="!documentItem" class="state-page state-page--loading">
    <v-progress-circular indeterminate color="primary" size="30" width="3" />
    <span>正在加载文档</span>
  </v-container>

  <v-container v-else-if="documentItem.status === 'completed'" class="reader-shell">
    <router-link class="back-link" to="/library"><v-icon icon="mdi-arrow-left" size="17" />公开文库</router-link>

    <header class="reader-header">
      <div class="reader-flags">
        <StatusChip :status="documentItem.status" />
        <span class="meta-pill"><v-icon :icon="documentItem.is_public ? 'mdi-earth' : 'mdi-lock-outline'" size="14" />{{ documentItem.is_public ? '公开文档' : '私有文档' }}</span>
        <span class="meta-pill"><v-icon icon="mdi-harddisk" size="14" />本地已归档</span>
        <span v-if="documentItem.r2_mirror_status === 'archived'" class="meta-pill"><v-icon icon="mdi-cloud-check-outline" size="14" />R2 已镜像</span>
        <span v-if="documentItem.translated" class="meta-pill"><v-icon icon="mdi-translate" size="14" />{{ documentItem.translation_provider === 'deepseek' ? 'DeepSeek 中文译文' : 'Google 中文译文' }}</span>
      </div>
      <h1>{{ documentItem.title }}</h1>
      <div class="reader-meta">
        <span>{{ formatDate(documentItem.created_at) }}</span>
        <span>{{ documentItem.display_filename }}</span>
        <span>{{ formatSize(documentItem.source_size) }}</span>
        <span>{{ documentItem.image_count }} 张图片</span>
        <span>耗时 {{ elapsedText() }}</span>
      </div>
    </header>

    <nav class="document-actions" aria-label="文档下载">
      <v-btn :href="`/api/v1/jobs/${documentItem.id}/bundle`" color="primary" prepend-icon="mdi-folder-zip-outline">下载完整归档</v-btn>
      <v-btn :href="`/api/v1/jobs/${documentItem.id}/source`" variant="outlined" prepend-icon="mdi-download">原始文件</v-btn>
      <v-btn v-if="documentItem.markdown_available?.normalized" :href="`/api/v1/jobs/${documentItem.id}/markdown?variant=normalized`" variant="outlined" prepend-icon="mdi-language-markdown">Markdown</v-btn>
      <v-menu>
        <template #activator="{ props }"><v-btn v-bind="props" variant="text" icon="mdi-dots-horizontal" aria-label="更多下载选项" /></template>
        <v-list density="compact">
          <v-list-item v-if="documentItem.markdown_available?.original" :href="`/api/v1/jobs/${documentItem.id}/markdown?variant=original`" prepend-icon="mdi-file-code-outline" title="MinerU 原稿" />
          <v-list-item v-if="documentItem.markdown_available?.translated" :href="`/api/v1/jobs/${documentItem.id}/markdown?variant=translated`" prepend-icon="mdi-translate" title="中文翻译稿" />
        </v-list>
      </v-menu>
    </nav>

    <v-expansion-panels class="audit-panels">
      <v-expansion-panel>
        <v-expansion-panel-title>
          <div class="audit-title"><strong>查看处理与归档记录</strong><span>{{ eventTotal }} 条事件 · 最终进度 100%</span></div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <StageOverview :document="documentItem" class="mb-5" />
          <ProcessingTimeline :events="events" :total="eventTotal" :created-at="documentItem.created_at" />
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <article class="article-surface article-content" v-html="documentItem.content_html" />
  </v-container>

  <v-container v-else class="task-shell">
    <router-link class="back-link" to="/library"><v-icon icon="mdi-arrow-left" size="17" />公开文库</router-link>

    <header class="task-header">
      <div class="task-header__status">
        <StatusChip :status="documentItem.status" />
        <span class="meta-pill"><v-icon :icon="documentItem.is_public ? 'mdi-earth' : 'mdi-lock-outline'" size="14" />{{ documentItem.is_public ? '公开' : '私有' }}</span>
        <span class="connection-mark" :class="`is-${connection}`"><i />{{ connectionText }}</span>
      </div>
      <h1>{{ documentItem.title }}</h1>
      <div class="task-meta">
        <span>{{ documentItem.display_filename }}</span>
        <span>{{ formatSize(documentItem.source_size) }}</span>
        <span>已运行 {{ elapsedText() }}</span>
        <span>{{ eventTotal }} 条事件</span>
      </div>
    </header>

    <div class="task-layout">
      <aside class="progress-sidebar">
        <div class="progress-value"><strong>{{ documentItem.progress }}</strong><span>%</span></div>
        <v-progress-linear :model-value="documentItem.progress" :color="documentItem.status === 'failed' ? 'error' : 'primary'" height="6" rounded />
        <p class="progress-stage">{{ latestEvent?.message || documentItem.stage }}</p>
        <dl class="progress-facts">
          <div><dt>当前阶段</dt><dd>{{ documentItem.stage }}</dd></div>
          <div><dt>源文件</dt><dd>已永久保存</dd></div>
          <div><dt>翻译</dt><dd>{{ documentItem.translation_provider === 'deepseek' ? 'DeepSeek' : documentItem.translation_provider === 'google' ? 'Google 免费翻译' : '未启用' }}</dd></div>
          <div><dt>本地归档</dt><dd>{{ documentItem.local_archive_status }}</dd></div>
        </dl>
        <div class="sidebar-actions">
          <v-btn :href="`/api/v1/jobs/${documentItem.id}/source`" variant="outlined" prepend-icon="mdi-download" block>下载源文件</v-btn>
          <v-btn :href="`/api/v1/jobs/${documentItem.id}/bundle`" variant="text" prepend-icon="mdi-folder-zip-outline" block>打包当前数据</v-btn>
        </div>
      </aside>

      <main class="task-main">
        <section class="current-step" :class="{ 'is-error': documentItem.status === 'failed' }">
          <div class="current-step__label">{{ documentItem.status === 'failed' ? '失败位置' : '正在执行' }}</div>
          <h2>{{ latestEvent?.message || documentItem.stage }}</h2>
          <p v-if="latestEvent?.detail">{{ latestEvent.detail }}</p>
          <div class="current-step__meta">
            <span v-if="latestEvent">事件 #{{ latestEvent.id }}</span>
            <span v-if="latestEvent?.current !== null && latestEvent?.current !== undefined">
              当前 {{ latestEvent.current }}<template v-if="latestEvent.total !== null"> / {{ latestEvent.total }}</template>
            </span>
            <span>{{ documentItem.progress }} / 100</span>
          </div>
        </section>

        <v-alert v-if="documentItem.status === 'failed'" type="error" variant="tonal" density="compact" class="mt-4">
          {{ documentItem.failure_reason || '任务处理失败，源文件和已有事件仍被保留。' }}
        </v-alert>

        <section class="task-section">
          <div class="task-section__head"><div><h2>处理阶段</h2><p>八个阶段按顺序执行，失败时停留在实际位置</p></div></div>
          <StageOverview :document="documentItem" />
        </section>

        <ProcessingTimeline class="task-section" :events="events" :total="eventTotal" :created-at="documentItem.created_at" :live="isLive" />

        <p class="task-footnote"><v-icon icon="mdi-information-outline" size="16" />离开页面不会中断任务；所有处理事件都会永久写入数据库。</p>
      </main>
    </div>
  </v-container>
</template>
