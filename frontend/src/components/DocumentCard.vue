<script setup lang="ts">
import { computed } from 'vue'
import { FileTextOutlined } from '@ant-design/icons-vue'
import type { DocumentSummary } from '../types'
import { processingModeLabel } from '../processingModes'
import StatusChip from './StatusChip.vue'

const props = defineProps<{ document: DocumentSummary }>()
const active = computed(() => ['processing', 'queued', 'retrying'].includes(props.document.status))
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value))
const formatSize = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
</script>

<template>
  <a-list-item>
    <a-list-item-meta>
      <template #avatar><FileTextOutlined class="document-file-icon" /></template>
      <template #title><router-link :to="`/documents/${document.id}`">{{ document.title }}</router-link><a-tag :color="document.processing_mode === 'pdf2zh' ? 'cyan' : 'default'" class="inline-tag">{{ processingModeLabel(document.processing_mode) }}</a-tag><a-tag v-if="document.translated" color="blue" class="inline-tag">中文</a-tag></template>
      <template #description><div class="document-excerpt">{{ document.excerpt || document.display_filename }}</div><span>{{ formatDate(document.created_at) }} · {{ formatSize(document.source_size) }}</span><a-progress v-if="active" :percent="document.progress" size="small" class="document-list-progress" /></template>
    </a-list-item-meta>
    <template #actions><StatusChip :status="document.status" /><router-link :to="`/documents/${document.id}`">查看</router-link></template>
  </a-list-item>
</template>
