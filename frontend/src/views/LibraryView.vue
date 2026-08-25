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

<template>
  <v-container class="library-shell">
    <header class="page-heading library-heading">
      <div>
        <h1>公开文库</h1>
        <p>共 {{ total }} 份文档，包含文章、原文件和完整处理记录。</p>
      </div>
      <v-btn to="/" color="primary" prepend-icon="mdi-tray-arrow-up">提交文档</v-btn>
    </header>

    <section class="library-toolbar" aria-label="文库筛选">
      <v-text-field v-model="query" prepend-inner-icon="mdi-magnify" placeholder="搜索标题或文件名" aria-label="搜索标题或文件名" hide-details clearable />
      <v-btn icon="mdi-refresh" variant="text" aria-label="刷新文库" :loading="loading" @click="load" />
    </section>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" height="2" class="library-loading" />

    <div v-if="items.length" class="document-list">
      <div class="document-list__head" aria-hidden="true">
        <span>文档</span><span>状态</span><span>日期</span><span>大小</span><span />
      </div>
      <DocumentCard v-for="document in items" :key="document.id" :document="document" />
    </div>

    <div v-else-if="!loading" class="empty-state">
      <span class="empty-state__icon"><v-icon icon="mdi-file-search-outline" size="28" /></span>
      <h2>{{ query ? '没有找到文档' : '还没有文档' }}</h2>
      <p>{{ query ? '换一个关键词再试试。' : '提交第一份文档后，它会出现在这里。' }}</p>
      <v-btn v-if="!query" to="/" color="primary" class="mt-4">提交文档</v-btn>
    </div>

    <v-pagination v-if="total > 20" v-model="page" :length="Math.ceil(total / 20)" class="mt-7" />
  </v-container>
</template>
