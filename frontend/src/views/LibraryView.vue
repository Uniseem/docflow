<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api } from '../api'
import DocumentCard from '../components/DocumentCard.vue'
import type { DocumentSummary } from '../types'

const items = ref<DocumentSummary[]>([])
const total = ref(0)
const page = ref(1)
const query = ref('')
const loading = ref(false)
const error = ref('')
let timer: number | undefined

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await api.listDocuments(page.value, 20, query.value)
    items.value = result.items
    total.value = result.total
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法加载文库'
  } finally {
    loading.value = false
  }
}

watch(query, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => { page.value = 1; void load() }, 300)
})
watch(page, load)
onMounted(load)
</script>
<template><v-container class="pb-16"><header class="library-head"><div class="eyebrow mb-2">Public archive</div><div class="d-flex flex-column flex-md-row align-md-end justify-space-between ga-5"><div><h1 class="page-title mb-2">公开文库</h1><p class="muted">{{ total }} 份文档及其永久处理记录。</p></div><v-text-field v-model="query" prepend-inner-icon="mdi-magnify" label="搜索标题或文件名" hide-details clearable style="max-width:360px" /></div></header><v-alert v-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert><v-progress-linear v-if="loading" indeterminate color="primary" height="3" class="mb-3" /><div v-if="items.length" class="document-list"><DocumentCard v-for="document in items" :key="document.id" :document="document" /></div><div v-else-if="!loading" class="empty-state"><v-icon icon="mdi-text-box-search-outline" size="42" color="secondary" class="mb-3" /><h2 class="text-h6 mb-2">{{ query?'没有匹配的文档':'文库还没有内容' }}</h2><p class="muted text-body-2">{{ query?'请尝试其他关键词。':'提交第一份文档后，处理过程会立即公开。' }}</p></div><v-pagination v-if="total>20" v-model="page" :length="Math.ceil(total/20)" class="mt-8" /></v-container></template>
