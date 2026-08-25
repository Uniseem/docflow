<script setup lang="ts">
import { computed } from 'vue'

import type { DocumentSummary } from '../types'
import StatusChip from './StatusChip.vue'

const props = defineProps<{ document: DocumentSummary }>()

const active = computed(() => ['processing', 'queued', 'retrying'].includes(props.document.status))
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(value))
const formatSize = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
</script>

<template>
  <router-link class="document-row" :to="`/documents/${document.id}`">
    <span class="document-row__icon"><v-icon icon="mdi-file-document-outline" size="20" /></span>
    <span class="document-row__main">
      <span class="document-row__title-line">
        <strong>{{ document.title }}</strong>
        <span v-if="document.translated" class="translation-mark">中文</span>
      </span>
      <span class="document-row__excerpt">{{ document.excerpt || (document.status === 'failed' ? document.failure_reason : document.display_filename) }}</span>
      <span class="document-row__mobile-meta">{{ formatDate(document.created_at) }} · {{ formatSize(document.source_size) }}</span>
      <v-progress-linear v-if="active" :model-value="document.progress" color="primary" height="3" rounded class="document-row__progress" />
    </span>
    <span class="document-row__status">
      <StatusChip :status="document.status" />
      <small v-if="active">{{ document.progress }}%</small>
    </span>
    <span class="document-row__meta">{{ formatDate(document.created_at) }}</span>
    <span class="document-row__meta">{{ formatSize(document.source_size) }}</span>
    <v-icon class="document-row__arrow" icon="mdi-chevron-right" size="19" />
  </router-link>
</template>
