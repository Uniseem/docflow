<script setup lang="ts">
import { computed } from 'vue'

import type { DocumentDetail } from '../types'

const props = defineProps<{ document: DocumentDetail }>()

const translationCaption = computed(() => ({
  1: '第 1 档 · Google Cloud · 共享池高速并发与占位符校验',
  2: '第 2 档 · DeepSeek V4 Flash · 非思考模式并发翻译',
  3: '第 3 档 · DeepSeek V4 Flash · 思考模式并发翻译',
}[props.document.translation_tier] || '翻译档位未知'))

const stages = computed(() => [
  { title: '接收与排队', caption: '上传、校验、PostgreSQL 入队', start: 0, end: 4, icon: 'mdi-database-arrow-down-outline' },
  { title: 'MinerU 解析', caption: '上传、轮询与逐页状态', start: 5, end: 52, icon: 'mdi-file-search-outline' },
  { title: '获取结果', caption: '受限下载与安全解压 ZIP', start: 53, end: 64, icon: 'mdi-archive-arrow-down-outline' },
  { title: '图片 WebP', caption: '转换、去重并改写本站路径', start: 65, end: 70, icon: 'mdi-image-sync-outline' },
  {
    title: props.document.translate_requested ? `中文翻译 · 第 ${props.document.translation_tier} 档` : '翻译（已跳过）',
    caption: props.document.translate_requested
      ? translationCaption.value
      : '历史任务未启用中文翻译',
    start: 71,
    end: 87,
    icon: props.document.translate_requested ? 'mdi-translate' : 'mdi-debug-step-over',
  },
  { title: '规范化与渲染', caption: '公式、间距、CommonMark、消毒', start: 88, end: 93, icon: 'mdi-code-tags-check' },
  { title: '本地永久归档', caption: '源文件、Markdown、HTML、WebP 与清单', start: 94, end: 98, icon: 'mdi-harddisk' },
  { title: '镜像与发布', caption: props.document.r2_mirror_status === 'archived' ? 'R2 镜像已校验，本地主副本保留' : 'R2 可选；本地归档直接发布', start: 99, end: 100, icon: 'mdi-check-decagram-outline' },
])

function stageState(stage: { start: number; end: number }) {
  const progress = props.document.progress
  if (props.document.status === 'failed' && progress >= stage.start && progress <= stage.end) return 'failed'
  if (progress > stage.end || (stage.end === 100 && progress === 100)) return 'completed'
  if (progress >= stage.start) return 'active'
  return 'pending'
}

function stateIcon(state: string, fallback: string) {
  if (state === 'completed') return 'mdi-check'
  if (state === 'failed') return 'mdi-alert-outline'
  if (state === 'active') return 'mdi-progress-clock'
  return fallback
}

function stateLabel(state: string) {
  return { completed: '完成', active: '进行中', failed: '失败', pending: '等待' }[state] || state
}
</script>

<template>
  <div class="stage-list" role="list" aria-label="文档处理阶段">
    <div v-for="(stage, index) in stages" :key="stage.title" class="stage-row" :class="`is-${stageState(stage)}`" role="listitem">
      <span class="stage-row__marker">
        <v-icon :icon="stateIcon(stageState(stage), stage.icon)" size="16" />
      </span>
      <span class="stage-row__copy">
        <span class="stage-row__title"><b>{{ index + 1 }}. {{ stage.title }}</b><small>{{ stateLabel(stageState(stage)) }}</small></span>
        <span class="stage-row__caption">{{ stage.caption }}</span>
      </span>
      <span class="stage-row__range">{{ stage.start === stage.end ? `${stage.end}%` : `${stage.start}–${stage.end}%` }}</span>
    </div>
  </div>
</template>
