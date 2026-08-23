<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ProcessingEvent } from '../types'

const props = defineProps<{
  events: ProcessingEvent[]
  total: number
  createdAt: string
  live?: boolean
}>()

const showAll = ref(false)
const newestFirst = computed(() => [...props.events].reverse())
const visibleEvents = computed(() => showAll.value ? newestFirst.value : newestFirst.value.slice(0, 200))

const stageLabels: Record<string, string> = {
  source_saved: '源文件', queued: '任务队列', worker_started: 'Worker', worker_claimed: 'Worker', source_verified: '源文件校验',
  mineru_requesting_upload: 'MinerU 准备',
  mineru_uploading: 'MinerU 上传', mineru_uploaded: 'MinerU 上传', mineru_resuming: 'MinerU 恢复',
  mineru_waiting: 'MinerU 轮询', 'mineru_waiting-file': 'MinerU 接收', mineru_pending: 'MinerU 排队',
  mineru_running: 'MinerU 解析', mineru_converting: 'MinerU 转换', mineru_retrying: 'MinerU 重连', mineru_done: 'MinerU 完成',
  result_download_starting: '结果准备', downloading_result: '结果下载', result_downloaded: '结果下载', archive_extracted: '安全解压',
  archive_inspected: '压缩包检查', archive_extracting: '安全解压', markdown_selected: 'Markdown 读取',
  images_discovered: '图片扫描', image_converted: 'WebP 转换', remote_image_localized: '外链本地化',
  images_verified: '图片复核', content_localized: '内容本地化', translation_preparing: '翻译准备',
  translation_prepared: '翻译分块', translation_chunk_started: '翻译分块', translation_chunk_attempt: '模型调用', translation_model_call: '模型调用',
  translation_placeholder_retry: '无损校验', translation_chunk_preserved: '原文保护',
  translation_api_retry: '模型重试', translation_chunk_retry: '校验重试', translation_chunk_failed: '翻译失败',
  translation_chunk_completed: '翻译完成', translation_completed: '翻译合并', translation_skipped: '跳过翻译',
  formatting_started: '排版准备', formula_normalized: '公式规范', math_protected: '公式保护',
  cjk_spacing: '中英文间距', markdown_formatted: 'Markdown 格式', math_restored: '公式恢复',
  unsafe_links_removed: '链接安全', html_rendered: 'HTML 渲染', html_sanitized: 'HTML 消毒',
  metadata_extracted: '元数据', local_archive_starting: '本地归档', local_archive_source: '永久源文件',
  local_archive_text: '永久文本', local_archive_image: '永久图片', local_archive_verified: '本地校验',
  r2_mirror_starting: 'R2 镜像', r2_mirror_object: 'R2 对象', r2_mirror_verified: 'R2 校验',
  r2_mirror_skipped: 'R2 已跳过', r2_mirror_failed: 'R2 镜像提醒', work_cleanup: '临时清理', work_cleanup_warning: '清理提醒',
  archive_starting: '旧版 R2 归档', archive_source: '旧版 R2 源文件', archive_text: '旧版 R2 文本',
  archive_image: '旧版 R2 图片', archive_verified: '旧版 R2 校验', local_cleanup: '旧版清理', local_cleanup_warning: '旧版清理提醒',
  retrying: '任务重试', failed: '最终失败', completed: '发布完成',
}

function eventColor(event: ProcessingEvent) {
  return { success: 'success', warning: 'warning', error: 'error', info: 'info' }[event.level] || 'info'
}

function eventIcon(event: ProcessingEvent) {
  if (event.state === 'failed') return 'mdi-close'
  if (event.state === 'warning') return 'mdi-alert-outline'
  if (event.state === 'completed') return 'mdi-check'
  return 'mdi-progress-clock'
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

function formatElapsed(value: string) {
  const seconds = Math.max(0, Math.round((new Date(value).getTime() - new Date(props.createdAt).getTime()) / 1000))
  if (seconds < 60) return `+${seconds} 秒`
  if (seconds < 3600) return `+${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `+${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分`
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function counterText(event: ProcessingEvent) {
  if (event.current === null) return ''
  if (event.stage.includes('download') || event.stage === 'source_saved' || event.stage === 'source_verified') {
    return event.total === null ? formatBytes(event.current) : `${formatBytes(event.current)} / ${formatBytes(event.total)}`
  }
  return event.total === null ? `${event.current}` : `${event.current} / ${event.total}`
}
</script>

<template>
  <section class="event-panel">
    <div class="event-panel__head">
      <div>
        <div class="d-flex align-center ga-2">
          <h2 class="text-h6 font-weight-bold">详细处理记录</h2>
          <span v-if="live" class="live-dot"><i />实时更新</span>
        </div>
        <p class="text-caption muted mt-1">共 {{ total }} 条永久事件，最新记录显示在最上方</p>
      </div>
      <v-chip size="small" variant="tonal" prepend-icon="mdi-database-clock-outline">已持久化</v-chip>
    </div>

    <div v-if="visibleEvents.length" class="event-list">
      <article v-for="event in visibleEvents" :key="event.id" class="event-row" :class="`event-${event.level}`">
        <div class="event-row__rail">
          <span class="event-dot" :class="`text-${eventColor(event)}`"><v-icon :icon="eventIcon(event)" size="15" /></span>
          <span class="event-line" />
        </div>
        <div class="event-row__body">
          <div class="event-row__meta">
            <span class="event-stage">{{ stageLabels[event.stage] || event.stage }}</span>
            <span>{{ formatClock(event.created_at) }}</span>
            <span>{{ formatElapsed(event.created_at) }}</span>
            <span class="event-percent">{{ event.progress }}%</span>
          </div>
          <div class="event-message">{{ event.message }}</div>
          <p v-if="event.detail" class="event-detail">{{ event.detail }}</p>
          <div v-if="counterText(event)" class="event-counter">
            <v-icon icon="mdi-counter" size="15" />{{ counterText(event) }}
          </div>
        </div>
      </article>
    </div>
    <v-alert v-else type="info" variant="tonal">正在等待第一条后台处理记录。</v-alert>

    <v-btn
      v-if="events.length > 200"
      block
      variant="tonal"
      color="secondary"
      class="mt-4"
      :prepend-icon="showAll ? 'mdi-chevron-up' : 'mdi-format-list-bulleted-square'"
      @click="showAll = !showAll"
    >
      {{ showAll ? '只显示最近 200 条' : `显示当前已载入的全部 ${events.length} 条` }}
    </v-btn>
  </section>
</template>
