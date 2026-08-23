<script setup lang="ts">
import type { DocumentSummary } from '../types'
import StatusChip from './StatusChip.vue'

defineProps<{ document: DocumentSummary }>()

const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value))
const formatSize = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
</script>
<template><v-card class="document-card" :to="`/documents/${document.id}`"><div class="document-primary"><div class="document-title">{{ document.title }}</div><div class="document-excerpt">{{ document.excerpt||(document.status==='failed'?document.failure_reason:`${document.display_filename} · ${document.progress}%`) }}</div><v-progress-linear v-if="['processing','queued','retrying'].includes(document.status)" :model-value="document.progress" color="primary" height="2" class="mt-2" /></div><div class="document-status"><span class="document-cell-label">状态</span><StatusChip :status="document.status" /></div><div class="document-date"><span class="document-cell-label">创建时间</span><div class="document-meta-value">{{ formatDate(document.created_at) }}</div></div><div class="document-size"><span class="document-cell-label">大小</span><div class="document-meta-value">{{ formatSize(document.source_size) }}</div></div></v-card></template>
