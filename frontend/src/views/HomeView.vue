<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '../api'
import DocumentCard from '../components/DocumentCard.vue'
import type { DocumentSummary, PublicConfig } from '../types'

const router = useRouter()
const config = ref<PublicConfig | null>(null)
const recent = ref<DocumentSummary[]>([])
const file = ref<File | null>(null)
const title = ref('')
const translate = ref(false)
const dragging = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const error = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const formatSize = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`

function chooseFile(selected?: File) {
  error.value = ''
  if (!selected) return
  const extension = `.${selected.name.split('.').pop()?.toLowerCase() || ''}`
  if (config.value && !config.value.accepted_extensions.includes(extension)) {
    error.value = `暂不支持 ${extension} 文件`
    return
  }
  if (config.value && selected.size > config.value.max_upload_mb * 1048576) {
    error.value = `文件不能超过 ${config.value.max_upload_mb} MB`
    return
  }
  file.value = selected
  if (!title.value.trim()) title.value = selected.name.replace(/\.[^.]+$/, '')
}

function handleDrop(event: DragEvent) {
  dragging.value = false
  chooseFile(event.dataTransfer?.files?.[0])
}

async function submit() {
  if (!file.value || uploading.value || !config.value?.accepting_uploads) return
  error.value = ''
  uploading.value = true
  uploadProgress.value = 0
  try {
    const document = await api.uploadDocument(file.value, title.value, translate.value, (value) => { uploadProgress.value = value })
    await router.push(`/documents/${document.id}`)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '上传失败'
  } finally {
    uploading.value = false
  }
}

onMounted(async () => {
  try {
    const [cfg, documents] = await Promise.all([api.publicConfig(), api.listDocuments(1, 5)])
    config.value = cfg
    translate.value = cfg.default_translate
    recent.value = documents.items
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '服务暂不可用'
  }
})
</script>

<template>
  <v-container>
    <header class="home-intro">
      <div class="eyebrow mb-3">公开文档处理服务</div>
      <h1 class="page-title mb-3">文档解析与中文翻译</h1>
      <p class="muted">提交 PDF、Office 文档、图片或 HTML。系统在后台完成 MinerU 解析、图片 WebP 转换、分块翻译和 Markdown 规范化，结果默认公开。</p>
      <div class="system-strip">
        <span><v-icon icon="mdi-eye-outline" size="16" />所有结果公开</span>
        <span><v-icon icon="mdi-harddisk" size="16" />本地永久归档</span>
        <span><v-icon icon="mdi-folder-zip-outline" size="16" />完整归档一键打包</span>
        <span><v-icon icon="mdi-cloud-outline" size="16" />R2 可选镜像</span>
      </div>
    </header>

    <v-card class="workspace-card">
      <div class="workspace-grid">
        <main class="upload-area">
          <div class="d-flex align-center justify-space-between mb-5">
            <div>
              <h2 class="text-h6 font-weight-bold">提交文档</h2>
              <p class="text-caption muted mt-1">单文件最大 {{ config?.max_upload_mb || 200 }} MB</p>
            </div>
            <v-chip :color="config?.accepting_uploads ? 'success' : 'warning'" size="small" variant="tonal">
              {{ config?.accepting_uploads ? '服务可用' : '等待配置' }}
            </v-chip>
          </div>
          <v-alert v-if="config && !config.mineru_configured" type="warning" variant="tonal" density="compact" class="mb-4">管理员尚未配置 MinerU，当前不能创建任务。</v-alert>
          <v-alert v-else-if="config && !config.r2_configured" type="info" variant="tonal" density="compact" class="mb-4">当前使用 VPS 本地永久归档；R2 未配置不会影响上传或处理。</v-alert>
          <div
            class="drop-zone"
            :class="{ 'is-dragging': dragging }"
            role="button"
            tabindex="0"
            @click="fileInput?.click()"
            @keydown.enter="fileInput?.click()"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="handleDrop"
          >
            <input ref="fileInput" hidden type="file" :accept="config?.accepted_extensions.join(',')" @change="chooseFile(($event.target as HTMLInputElement).files?.[0])">
            <div v-if="!file">
              <div class="drop-icon"><v-icon icon="mdi-tray-arrow-up" size="26" /></div>
              <h3 class="text-subtitle-1 font-weight-bold mb-1">拖入文件，或点击选择</h3>
              <p class="text-caption muted">PDF · Word · PowerPoint · Excel · 图片 · HTML</p>
            </div>
            <div v-else class="selected-file">
              <v-icon icon="mdi-file-check-outline" color="success" size="25" />
              <div>
                <div class="selected-file__name">{{ file.name }}</div>
                <div class="text-caption muted mt-1">{{ formatSize(file.size) }} · 点击可更换</div>
              </div>
            </div>
          </div>
          <v-text-field v-if="file" v-model="title" class="mt-4" label="公开展示标题" hint="只写入数据库，不作为服务器物理文件名" persistent-hint maxlength="512" />
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">{{ error }}</v-alert>
          <v-progress-linear v-if="uploading" :model-value="uploadProgress" color="primary" height="6" class="mt-5" />
        </main>

        <aside class="upload-side">
          <div class="side-row">
            <strong>中文翻译</strong>
            <small>DeepSeek 按段调用；公式、代码、图片和链接先做无损保护。</small>
            <v-switch v-model="translate" color="primary" density="compact" hide-details :disabled="!config?.translation_available" label="翻译为简体中文" class="mt-2" />
          </div>
          <div class="side-row">
            <strong>文件命名</strong>
            <small>展示标题和下载名保存在数据库；磁盘使用 UUID 目录与固定 ASCII 文件名，避免中文编码问题。</small>
          </div>
          <div class="side-row">
            <strong>数据策略</strong>
            <small>源文件先永久落盘，随后补齐 Markdown、HTML、WebP、MinerU 结果与事件清单；R2 只作可选镜像。</small>
          </div>
          <v-btn block color="primary" size="large" class="mt-5" :disabled="!file || !config?.accepting_uploads" :loading="uploading" @click="submit">
            {{ uploading ? `上传 ${uploadProgress}%` : '创建处理任务' }}
          </v-btn>
        </aside>
      </div>
    </v-card>

    <section v-if="recent.length" class="recent-section">
      <div class="d-flex align-center justify-space-between mb-4">
        <div><div class="eyebrow mb-2">最近任务</div><h2 class="section-title">公开处理记录</h2></div>
        <v-btn to="/library" variant="text" append-icon="mdi-arrow-right">全部文档</v-btn>
      </div>
      <div class="document-list"><DocumentCard v-for="document in recent" :key="document.id" :document="document" /></div>
    </section>
  </v-container>
</template>
