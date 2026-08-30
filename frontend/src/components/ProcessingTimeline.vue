<script setup lang="ts">
import { computed, ref } from 'vue'
import { Select as ASelect, Timeline as ATimeline, TimelineItem as ATimelineItem } from 'ant-design-vue'
import type { ProcessingEvent } from '../types'
import { nativePdfStageLabel } from '../processingModes'

const props = defineProps<{ events: ProcessingEvent[]; total: number; createdAt: string; live?: boolean }>()
const showAll = ref(false)
const filter = ref('all')
const filteredEvents = computed(() => [...props.events].reverse().filter((event) => filter.value !== 'attention' || ['warning', 'error'].includes(event.level)))
const visibleEvents = computed(() => showAll.value ? filteredEvents.value : filteredEvents.value.slice(0, 200))

const stageLabels: Record<string, string> = {
  source_saved: '源文件', queued: '任务队列', worker_started: 'Worker', worker_claimed: 'Worker', source_verified: '源文件校验',
  mineru_requesting_upload: 'MinerU 准备',
  mineru_uploading: 'MinerU 上传', mineru_uploaded: 'MinerU 上传', mineru_resuming: 'MinerU 恢复',
  mineru_waiting: 'MinerU 轮询', 'mineru_waiting-file': 'MinerU 接收', mineru_pending: 'MinerU 排队',
  mineru_running: 'MinerU 解析', mineru_converting: 'MinerU 转换', mineru_retrying: 'MinerU 重连', mineru_done: 'MinerU 完成',
  mineru_network_retry: 'MinerU 网络重试',
  result_download_starting: '结果准备', downloading_result: '结果下载', result_downloaded: '结果下载', archive_extracted: '安全解压',
  archive_inspected: '压缩包检查', archive_extracting: '安全解压', markdown_selected: 'Markdown 读取',
  images_discovered: '图片扫描', image_converted: 'WebP 转换', remote_image_localized: '外链本地化',
  images_verified: '图片复核', content_localized: '内容本地化', translation_preparing: '翻译准备',
  images_localized: '图片本地化完成',
  translation_pool_selected: '选择任务池', translation_chunks_prepared: '并发计划',
  translation_pool_queued: '共享池排队', translation_concurrent: '并发翻译',
  translation_provider_retry: '重新排队',
  translation_batch_queued: '批量请求排队', translation_batch_fallback: '批量降级处理', translation_batch_segment_retry: '批次分段重试',
  translation_review_started: '全文速览', translation_review_part: '全文阅读', translation_review_part_completed: '速览完成',
  translation_review_reducing: '记忆归并', translation_review_consolidating: '约束整理', translation_constraints_ready: '翻译约束',
  translation_review_api_retry: '速览重试',
  translation_prepared: '翻译分块', translation_chunk_started: '翻译分块', translation_chunk_attempt: '服务调用', translation_model_call: '模型调用', translation_provider_call: '服务调用',
  translation_placeholder_retry: '无损校验', translation_placeholder_repaired: '标记自愈', translation_chunk_preserved: '原文保护',
  translation_fragment_fallback: '隔离降级', translation_fragment_queued: '片段排队', translation_fragment_completed: '片段完成',
  translation_chunk_cache_hit: '断点复用', translation_cache_warning: '断点提醒',
  translation_api_retry: '服务重试', translation_chunk_retry: '校验重试', translation_chunk_failed: '翻译失败',
  translation_chunk_completed: '翻译完成', translation_completed: '翻译合并', translation_skipped: '跳过翻译',
  formatting_started: '排版准备', formula_normalized: '公式规范', math_protected: '公式保护',
  cjk_spacing: '中英文间距', markdown_formatted: 'Markdown 格式', math_restored: '公式恢复',
  markdown_normalized: 'Markdown 规范化',
  unsafe_links_removed: '链接安全', html_rendered: 'HTML 渲染', html_sanitized: 'HTML 消毒',
  pdf_layout_started: 'PDF 排版', pdf_render_retry: 'PDF 重试', pdf_rendered: 'PDF 生成', pdf_render_failed: 'PDF 生成提醒',
  metadata_extracted: '元数据', local_archive_starting: '本地归档', local_archive_source: '永久源文件',
  local_archive_text: '永久文本', local_archive_image: '永久图片', local_archive_verified: '本地校验',
  r2_mirror_starting: 'R2 镜像', r2_mirror_object: 'R2 对象', r2_mirror_verified: 'R2 校验',
  r2_mirror_skipped: 'R2 已跳过', r2_mirror_failed: 'R2 镜像提醒', work_cleanup: '临时清理', work_cleanup_warning: '清理提醒',
  archive_starting: '旧版 R2 归档', archive_source: '旧版 R2 源文件', archive_text: '旧版 R2 文本',
  archive_image: '旧版 R2 图片', archive_verified: '旧版 R2 校验', local_cleanup: '旧版清理', local_cleanup_warning: '旧版清理提醒',
  retrying: '任务重试', manual_retry_queued: '人工重试', failed: '最终失败', completed: '发布完成',
}
function eventColor(event: ProcessingEvent) { return { success: 'green', warning: 'orange', error: 'red', info: 'blue' }[event.level] || 'blue' }
function formatClock(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}
function formatElapsed(value: string) {
  const seconds = Math.max(0, Math.round((new Date(value).getTime() - new Date(props.createdAt).getTime()) / 1000))
  if (seconds < 60) return `+${seconds} 秒`
  if (seconds < 3600) return `+${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `+${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分`
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1048576).toFixed(1)} MB`
}
function counterText(event: ProcessingEvent) {
  if (event.current === null) return ''
  if (event.stage.includes('download') || ['source_saved', 'source_verified'].includes(event.stage)) return event.total === null ? formatBytes(event.current) : `${formatBytes(event.current)} / ${formatBytes(event.total)}`
  return event.total === null ? String(event.current) : `${event.current} / ${event.total}`
}
</script>

<template>
  <a-card title="详细处理记录" class="timeline-card">
    <template #extra><a-badge v-if="live" status="processing" text="实时更新" /><a-tag v-else>已保存</a-tag></template>
    <div class="table-toolbar"><span class="text-secondary">共 {{ total }} 条永久事件，最新记录在前</span><a-select v-model:value="filter" aria-label="筛选处理记录" :options="[{ label: '全部记录', value: 'all' }, { label: '仅警告与错误', value: 'attention' }]" class="event-filter" /></div>
    <div v-if="visibleEvents.length" class="timeline-scroll">
      <a-timeline>
        <a-timeline-item v-for="event in visibleEvents" :key="event.id" :color="eventColor(event)">
          <div class="event-meta"><a-tag :color="eventColor(event)">{{ stageLabels[event.stage] || nativePdfStageLabel(event.stage) || event.stage }}</a-tag><span>{{ formatClock(event.created_at) }}</span><span>{{ formatElapsed(event.created_at) }}</span><span>#{{ event.id }}</span><span>{{ event.progress }}%</span></div>
          <div class="event-message">{{ event.message }}</div>
          <p v-if="event.detail" class="event-detail">{{ event.detail }}</p>
          <div v-if="counterText(event)" class="event-counter">数量 / 进度：{{ counterText(event) }}</div>
        </a-timeline-item>
      </a-timeline>
    </div>
    <a-empty v-else :description="filter === 'attention' ? '没有警告或错误记录' : '等待后台记录'" />
    <a-button v-if="filteredEvents.length > 200" type="link" block @click="showAll = !showAll">{{ showAll ? '只显示最近 200 条' : `显示已载入的全部 ${filteredEvents.length} 条` }}</a-button>
  </a-card>
</template>
