<script setup lang="ts">
import { computed } from 'vue'
import type { DocumentStatus } from '../types'

const props = defineProps<{ status: DocumentStatus }>()
const state = computed(() => ({
  queued: { label: '等待中', color: 'warning', icon: 'mdi-clock-outline' },
  processing: { label: '处理中', color: 'info', icon: 'mdi-progress-clock' },
  retrying: { label: '重试中', color: 'warning', icon: 'mdi-refresh' },
  completed: { label: '已发布', color: 'success', icon: 'mdi-check-circle-outline' },
  failed: { label: '处理失败', color: 'error', icon: 'mdi-alert-circle-outline' },
}[props.status] || { label: props.status, color: 'grey', icon: 'mdi-help-circle-outline' }))
</script>

<template>
  <span class="status-chip" :class="`status-${status}`">
    <v-icon :icon="state.icon" size="14" />
    {{ state.label }}
  </span>
</template>
