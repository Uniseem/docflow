<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Pagination as APagination } from 'ant-design-vue'
import { ReloadOutlined, UploadOutlined } from '@ant-design/icons-vue'
import { api } from '../api'
import DocumentCard from '../components/DocumentCard.vue'
import type { DocumentSummary } from '../types'

const items = ref<DocumentSummary[]>([])
const total = ref(0)
const page = ref(1)
const query = ref('')
const loading = ref(false)
const error = ref('')
let requestId = 0
let unmounted = false

async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const result = await api.listDocuments(page.value, 20, query.value.trim())
    if (unmounted || id !== requestId) return
    items.value = result.items
    total.value = result.total
  } catch (reason) {
    if (id === requestId) error.value = reason instanceof Error ? reason.message : '无法加载文库'
  } finally {
    if (id === requestId) loading.value = false
  }
}
function search() { page.value = 1; void load() }
function changePage(value: number) { page.value = value; void load() }
onMounted(load)
onBeforeUnmount(() => { unmounted = true })
</script>

<template>
  <div class="page-container">
    <div class="page-heading"><div><h1>公开文库</h1><p>共 {{ total }} 份文档，仅展示管理员主动公开的内容。</p></div><router-link to="/"><a-button type="primary"><template #icon><UploadOutlined /></template>提交文档</a-button></router-link></div>
    <a-card>
      <div class="table-toolbar"><a-input-search v-model:value="query" placeholder="按标题或文件名搜索" aria-label="按标题或文件名搜索" allow-clear enter-button="搜索" class="search-input" @search="search" /><a-button :loading="loading" @click="load"><template #icon><ReloadOutlined /></template>刷新</a-button></div>
      <a-alert v-if="error" type="error" :message="error" show-icon class="section-gap" />
      <a-spin :spinning="loading">
        <a-list v-if="items.length" :data-source="items"><template #renderItem="{ item }"><DocumentCard :document="item" /></template></a-list>
        <a-empty v-else :description="query ? '没有匹配的公开文档' : '暂时没有公开文档'" class="empty-block"><router-link v-if="!query" to="/"><a-button type="primary">提交文档</a-button></router-link></a-empty>
      </a-spin>
      <a-pagination v-if="total > 20" :current="page" :page-size="20" :total="total" :show-size-changer="false" :show-total="(count: number) => `共 ${count} 份文档`" class="table-pagination" @change="changePage" />
    </a-card>
  </div>
</template>
