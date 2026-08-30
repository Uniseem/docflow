<script setup lang="ts">
import { computed } from 'vue'
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, LoadingOutlined, SyncOutlined } from '@ant-design/icons-vue'
import type { DocumentStatus } from '../types'

const props = defineProps<{ status: DocumentStatus }>()
const state = computed(() => ({
  queued: { label: '等待处理', color: 'default', icon: ClockCircleOutlined },
  processing: { label: '处理中', color: 'processing', icon: LoadingOutlined },
  retrying: { label: '自动重试', color: 'warning', icon: SyncOutlined },
  completed: { label: '已完成', color: 'success', icon: CheckCircleOutlined },
  failed: { label: '处理失败', color: 'error', icon: CloseCircleOutlined },
}[props.status]))
</script>

<template>
  <a-tag :color="state.color"><template #icon><component :is="state.icon" /></template>{{ state.label }}</a-tag>
</template>
