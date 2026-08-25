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
    const document = await api.uploadDocument(file.value, title.value, (value) => { uploadProgress.value = value })
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
    recent.value = documents.items
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '服务暂不可用'
  }
})
</script>

<template>
  <v-container class="home-shell">
    <header class="page-heading home-heading">
      <div>
        <h1>上传文档</h1>
        <p>解析、翻译并整理为可直接阅读和下载的标准文档。</p>
      </div>
      <div class="service-status" :class="{ 'is-ready': config?.accepting_uploads }">
        <span class="service-status__dot" />
        {{ config?.accepting_uploads ? '服务正常' : '服务未就绪' }}
      </div>
    </header>

    <v-alert v-if="config && !config.mineru_configured" type="warning" variant="tonal" density="compact" class="mb-4">MinerU 尚未配置，当前不能提交文档。</v-alert>

    <section class="upload-panel">
      <main class="upload-main">
        <div class="panel-title-row">
          <div>
            <h2>选择文件</h2>
            <p>支持 PDF、Word、PowerPoint、Excel、图片和 HTML，最大 {{ config?.max_upload_mb || 200 }} MB</p>
          </div>
          <span class="step-number">01</span>
        </div>

        <div
          class="drop-zone"
          :class="{ 'is-dragging': dragging, 'has-file': file }"
          role="button"
          tabindex="0"
          @click="fileInput?.click()"
          @keydown.enter="fileInput?.click()"
          @keydown.space.prevent="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="handleDrop"
        >
          <input ref="fileInput" hidden type="file" :accept="config?.accepted_extensions.join(',')" @change="chooseFile(($event.target as HTMLInputElement).files?.[0])">
          <template v-if="!file">
            <span class="drop-icon"><v-icon icon="mdi-tray-arrow-up" size="23" /></span>
            <div>
              <strong>拖放文件到这里</strong>
              <span>或点击浏览本地文件</span>
            </div>
            <v-btn variant="outlined" size="small" tabindex="-1">选择文件</v-btn>
          </template>
          <template v-else>
            <span class="file-type-icon"><v-icon icon="mdi-file-document-outline" size="23" /></span>
            <div class="selected-file-copy">
              <strong>{{ file.name }}</strong>
              <span>{{ formatSize(file.size) }} · 点击可更换</span>
            </div>
            <v-icon icon="mdi-check-circle" color="success" size="22" />
          </template>
        </div>

        <v-text-field v-if="file" v-model="title" class="title-field" label="文档标题" hint="可以使用中文；服务器实际文件名始终使用安全编码" persistent-hint maxlength="512" />
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">{{ error }}</v-alert>
        <div v-if="uploading" class="upload-progress">
          <div><span>正在上传源文件</span><strong>{{ uploadProgress }}%</strong></div>
          <v-progress-linear :model-value="uploadProgress" color="primary" height="5" rounded />
        </div>
      </main>

      <aside class="upload-options">
        <div class="panel-title-row">
          <div>
            <h2>处理选项</h2>
            <p>提交后可离开页面，任务会继续运行</p>
          </div>
          <span class="step-number">02</span>
        </div>

        <div class="option-row">
          <span class="option-icon"><v-icon icon="mdi-translate" size="19" /></span>
          <span class="option-copy">
            <strong>自动翻译为简体中文</strong>
            <small>{{ config?.translation_provider === 'deepseek' ? '全站使用管理员配置的 DeepSeek' : '全站使用 Google 免费翻译' }}；分段处理并保护公式、代码和链接</small>
          </span>
          <span class="option-fixed">全站统一</span>
        </div>

        <div class="processing-notes">
          <div><v-icon icon="mdi-lock-outline" size="17" /><span><strong>默认私有</strong><small>仅当前上传浏览器与管理员可见，管理员可公开</small></span></div>
          <div><v-icon icon="mdi-harddisk" size="17" /><span><strong>永久保存</strong><small>源文件、Markdown 和 WebP 保存在本机</small></span></div>
          <div><v-icon icon="mdi-progress-clock" size="17" /><span><strong>详细进度</strong><small>每个解析、翻译和归档步骤实时更新</small></span></div>
        </div>

        <v-btn block color="primary" size="large" :disabled="!file || !config?.accepting_uploads" :loading="uploading" @click="submit">
          {{ uploading ? `正在上传 ${uploadProgress}%` : '开始处理' }}
        </v-btn>
      </aside>
    </section>

    <section v-if="recent.length" class="recent-section">
      <div class="section-heading">
        <div><h2>公开文档</h2><p>由管理员主动公开的最新文档</p></div>
        <v-btn to="/library" variant="text" append-icon="mdi-arrow-right" size="small">查看全部</v-btn>
      </div>
      <div class="document-list"><DocumentCard v-for="document in recent" :key="document.id" :document="document" /></div>
    </section>
  </v-container>
</template>
