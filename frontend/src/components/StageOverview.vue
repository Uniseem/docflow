<script setup lang="ts">
import { computed } from 'vue'
import type { DocumentDetail } from '../types'
import { processingStageItems } from '../processingStages'

const props = defineProps<{ document: DocumentDetail }>()
const stageItems = computed(() => processingStageItems(props.document))
</script>

<template>
  <a-steps direction="vertical" size="small" :items="stageItems" aria-label="文档处理阶段" />
</template>
