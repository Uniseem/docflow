<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
const translationNotice = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
type TranslationTier = 1 | 2 | 3
const selectedTranslationTier = ref<TranslationTier>(1)

const translationTiers = [
  { tier: 1, name: '极速', engine: 'Google Cloud', detail: '官方翻译 API · 高速并发', icon: 'mdi-flash-outline' },
  { tier: 2, name: '均衡', engine: 'DeepSeek V4 Flash', detail: '非思考模式 · 自然准确', icon: 'mdi-scale-balance' },
  { tier: 3, name: '精准', engine: 'DeepSeek V4 Flash', detail: '思考模式 · 复杂论文优先', icon: 'mdi-brain' },
] as const

const selectedTier = computed(() => translationTiers.find((item) => item.tier === selectedTranslationTier.value) || translationTiers[0])

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

function tierAvailable(tier: TranslationTier) {
  return tier === 1 ? Boolean(config.value?.google_configured) : Boolean(config.value?.deepseek_configured)
}

function selectTranslationTier(tier: TranslationTier) {
  if (!tierAvailable(tier)) {
    translationNotice.value = tier === 1
      ? '极速档需要管理员先在后台配置 Google Cloud Translation API Key。'
      : '均衡档和精准档需要管理员先在后台配置 DeepSeek API Key。'
    return
  }
  selectedTranslationTier.value = tier
  translationNotice.value = ''
}

async function submit() {
  if (!file.value || uploading.value || !config.value?.accepting_uploads) return
  error.value = ''
  uploading.value = true
  uploadProgress.value = 0
  try {
    const document = await api.uploadDocument(file.value, title.value, selectedTranslationTier.value, (value) => { uploadProgress.value = value })
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
    selectedTranslationTier.value = cfg.translation_tier
    recent.value = documents.items
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '服务暂不可用'
  }
})
</script>

<template>
  <v-container class="home-shell">
    <header class="home-hero">
      <div class="home-hero__copy">
        <span class="eyebrow">DOCUMENT WORKFLOW</span>
        <h1>把文档变成<br>可直接阅读的中文文章</h1>
        <p>提交 PDF、Office 或图片。解析、翻译、公式排版和期刊 PDF 生成都在后台自动完成。</p>
      </div>
      <div class="service-card" :class="{ 'is-ready': config?.accepting_uploads }">
        <span class="service-card__icon"><v-icon :icon="config?.accepting_uploads ? 'mdi-check' : 'mdi-alert-outline'" size="20" /></span>
        <span><strong>{{ config?.accepting_uploads ? '可以提交' : '服务未就绪' }}</strong><small>{{ config?.accepting_uploads ? '后台处理服务运行正常' : '请联系管理员完成配置' }}</small></span>
      </div>
    </header>

    <v-alert v-if="config && !config.mineru_configured" type="warning" variant="tonal" class="workspace-alert">MinerU 尚未配置，当前不能提交文档。</v-alert>
    <v-alert v-else-if="config && !config.translation_available" type="warning" variant="tonal" class="workspace-alert">尚未配置 Google Cloud Translation 或 DeepSeek，当前不能提交文档。</v-alert>

    <section class="upload-workspace">
      <div class="workspace-section">
        <div class="workspace-heading">
          <span class="workspace-step">01</span>
          <div><h2>选择文档</h2><p>PDF、Word、PowerPoint、Excel、图片或 HTML，最大 {{ config?.max_upload_mb || 200 }} MB</p></div>
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
            <span class="drop-icon"><v-icon icon="mdi-arrow-up" size="26" /></span>
            <div class="drop-copy"><strong>拖放文件到这里</strong><span>或者点击选择本地文件</span></div>
            <span class="drop-action">浏览文件</span>
          </template>
          <template v-else>
            <span class="file-type-icon"><v-icon icon="mdi-file-document-outline" size="26" /></span>
            <div class="selected-file-copy">
              <strong>{{ file.name }}</strong>
              <span>{{ formatSize(file.size) }} · 点击可更换</span>
            </div>
            <span class="file-ready"><v-icon icon="mdi-check" size="18" />已选择</span>
          </template>
        </div>

        <v-text-field v-if="file" v-model="title" class="title-field" label="文档标题" hint="可以使用中文；服务器实际文件名始终使用安全编码" persistent-hint maxlength="512" />
        <v-alert v-if="error" type="error" variant="tonal" class="mt-4">{{ error }}</v-alert>
        <div v-if="uploading" class="upload-progress">
          <div><span>正在上传源文件</span><strong>{{ uploadProgress }}%</strong></div>
          <v-progress-linear :model-value="uploadProgress" color="primary" height="8" rounded />
        </div>
      </div>

      <div class="workspace-divider" />

      <div class="workspace-section">
        <div class="workspace-heading">
          <span class="workspace-step">02</span>
          <div><h2>选择翻译质量</h2><p>管理员设定默认档位，你可以为本次任务选择任一已开放档位</p></div>
          <span class="selected-tier-label">本次使用第 {{ selectedTranslationTier }} 档</span>
        </div>

        <div class="tier-grid" role="radiogroup" aria-label="本次任务翻译质量">
          <button
            v-for="item in translationTiers"
            :key="item.tier"
            type="button"
            class="tier-card"
            :class="{ 'is-active': item.tier === selectedTranslationTier, 'is-unavailable': !tierAvailable(item.tier) }"
            role="radio"
            :aria-checked="item.tier === selectedTranslationTier"
            :aria-disabled="!tierAvailable(item.tier)"
            @click="selectTranslationTier(item.tier)"
          >
            <span class="tier-card__top"><b>0{{ item.tier }}</b><span v-if="item.tier === config?.translation_tier">默认</span><v-icon v-if="!tierAvailable(item.tier)" icon="mdi-lock-outline" size="18" /></span>
            <span class="tier-card__icon"><v-icon :icon="item.icon" size="28" /></span>
            <span class="tier-card__copy"><strong>{{ item.name }}</strong><small>{{ item.engine }}</small><em>{{ item.detail }}</em></span>
            <span class="tier-card__choice"><template v-if="item.tier === selectedTranslationTier"><v-icon icon="mdi-check" size="16" />已选择</template><template v-else-if="!tierAvailable(item.tier)">尚未开放</template><template v-else>选择此档</template></span>
          </button>
        </div>
        <p v-if="translationNotice" class="tier-note is-warning"><v-icon icon="mdi-information-outline" size="18" />{{ translationNotice }}</p>
        <p v-else class="tier-note"><v-icon icon="mdi-check-circle-outline" size="18" />已选择“{{ selectedTier.name }}”；提交后任务将固定使用第 {{ selectedTranslationTier }} 档。</p>
      </div>

      <footer class="workspace-footer">
        <div class="processing-notes">
          <span><v-icon icon="mdi-lock-outline" size="19" /><b>默认私有</b></span>
          <span><v-icon icon="mdi-harddisk" size="19" /><b>永久保存</b></span>
          <span><v-icon icon="mdi-file-pdf-box" size="19" /><b>生成期刊 PDF</b></span>
          <span><v-icon icon="mdi-progress-clock" size="19" /><b>实时详细进度</b></span>
        </div>
        <v-btn class="submit-button" color="primary" size="x-large" append-icon="mdi-arrow-right" :disabled="!file || !config?.accepting_uploads" :loading="uploading" @click="submit">
          {{ uploading ? `正在上传 ${uploadProgress}%` : '开始处理文档' }}
        </v-btn>
      </footer>
    </section>

    <section v-if="recent.length" class="recent-section">
      <div class="section-heading">
        <div><span class="eyebrow">PUBLIC LIBRARY</span><h2>最近公开</h2><p>由管理员主动公开的最新文档</p></div>
        <v-btn to="/library" variant="outlined" append-icon="mdi-arrow-right">查看文库</v-btn>
      </div>
      <div class="document-list"><DocumentCard v-for="document in recent" :key="document.id" :document="document" /></div>
    </section>
  </v-container>
</template>
