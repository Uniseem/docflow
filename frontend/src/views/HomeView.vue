<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CloudUploadOutlined, FileTextOutlined, InboxOutlined, LockOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { api } from '../api'
import DocumentCard from '../components/DocumentCard.vue'
import { acceptedExtensions, initialProcessingMode, processingModeAvailable, processingModes, validateUpload } from '../processingModes'
import type { DocumentSummary, ProcessingMode, PublicConfig } from '../types'

const router = useRouter()
const config = ref<PublicConfig | null>(null)
const recent = ref<DocumentSummary[]>([])
const file = ref<File | null>(null)
const title = ref('')
const uploading = ref(false)
const configLoading = ref(false)
const uploadProgress = ref(0)
const error = ref('')
type TranslationTier = 1 | 2 | 3
const selectedTranslationTier = ref<TranslationTier>(1)
const selectedProcessingMode = ref<ProcessingMode>('mineru')

const translationTiers = [
  { tier: 1, name: '极速', engine: 'Google Cloud', detail: '官方翻译 API，适合快速阅读。' },
  { tier: 2, name: '均衡', engine: 'DeepSeek V4 Flash', detail: '非思考模式，兼顾翻译速度与准确度。' },
  { tier: 3, name: '精准', engine: 'DeepSeek V4 Flash', detail: '思考模式，适合复杂句式与专业术语。' },
] as const
const selectedTier = computed(() => translationTiers.find((item) => item.tier === selectedTranslationTier.value) || translationTiers[0])
const selectedMode = computed(() => processingModes.find((item) => item.value === selectedProcessingMode.value) || processingModes[0])
const modeReady = computed(() => processingModeAvailable(config.value, selectedProcessingMode.value))
const allowedExtensions = computed(() => acceptedExtensions(config.value, selectedProcessingMode.value))
// This also revalidates an already-selected file whenever the mode or server limits change.
const fileValidation = computed(() => file.value ? validateUpload(file.value, config.value, selectedProcessingMode.value) : '')
const canSubmit = computed(() => Boolean(file.value && !fileValidation.value && modeReady.value && tierAvailable(selectedTranslationTier.value) && !uploading.value))
const unavailableReason = computed(() => {
  if (!config.value) return ''
  if (!config.value.translation_available) return '尚未配置可用的翻译服务，请联系管理员。'
  if (selectedProcessingMode.value === 'mineru' && !config.value.mineru_configured) return 'MinerU 尚未配置。可切换到 PDF 原生翻译，或联系管理员配置 MinerU。'
  if (!modeReady.value) return `${selectedMode.value.label}暂不可用，请联系管理员检查服务配置。`
  return ''
})
const processingSteps = computed(() => selectedProcessingMode.value === 'pdf2zh'
  ? [{ title: '检查与分析 PDF', description: '检查文本层，分析原文页面布局' }, { title: '原文翻译与排版', description: '按所选档位翻译，保留页面版式' }, { title: '校验与归档', description: '保存原 PDF、中文单语 PDF 与双语 PDF' }]
  : [{ title: '解析文档', description: '由 MinerU 识别正文、图片和公式' }, { title: '并发翻译', description: '按所选档位分段翻译，实时显示进度' }, { title: '规范化与归档', description: '本地保存 Markdown、期刊式 PDF 和 WebP 图片' }])
const formatSize = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`

function chooseFile(selected: File) {
  error.value = ''
  if (uploading.value) return false
  const validation = validateUpload(selected, config.value, selectedProcessingMode.value)
  if (validation) {
    error.value = validation
    return false
  }
  const previousName = file.value?.name.replace(/\.[^.]+$/, '')
  file.value = selected
  if (!title.value.trim() || title.value === previousName) title.value = selected.name.replace(/\.[^.]+$/, '')
  return false
}

function tierAvailable(tier: TranslationTier) {
  return tier === 1 ? Boolean(config.value?.google_configured) : Boolean(config.value?.deepseek_configured)
}

async function loadConfig() {
  if (configLoading.value) return
  configLoading.value = true
  try {
    const initial = !config.value
    config.value = await api.publicConfig()
    if (initial) {
      selectedTranslationTier.value = config.value.translation_tier
      selectedProcessingMode.value = initialProcessingMode(config.value)
    }
    if (!tierAvailable(selectedTranslationTier.value)) {
      const available = translationTiers.find((tier) => tierAvailable(tier.tier))
      if (available) selectedTranslationTier.value = available.tier
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '服务暂不可用'
  } finally {
    configLoading.value = false
  }
}

async function submit() {
  if (!file.value || !canSubmit.value) return
  error.value = ''
  uploading.value = true
  uploadProgress.value = 0
  try {
    const result = await api.uploadDocument(file.value, title.value, selectedTranslationTier.value, selectedProcessingMode.value, (value) => { uploadProgress.value = value })
    await router.push(`/documents/${result.id}`)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '上传失败'
  } finally {
    uploading.value = false
  }
}

watch(selectedProcessingMode, () => { error.value = '' })
onMounted(() => {
  void loadConfig()
  void api.listDocuments(1, 5).then((response) => { recent.value = response.items }).catch(() => undefined)
  window.addEventListener('focus', loadConfig)
})
onBeforeUnmount(() => window.removeEventListener('focus', loadConfig))
</script>

<template>
  <div class="page-container">
    <div class="page-heading">
      <div><h1>提交文档</h1><p>解析、翻译并整理为可阅读、可下载的文档。</p></div>
      <a-space><a-badge :status="modeReady ? 'success' : 'warning'" :text="modeReady ? '所选流程可用' : configLoading ? '读取服务状态' : '所选流程未就绪'" /><a-button :loading="configLoading" aria-label="刷新服务状态" @click="loadConfig"><template #icon><ReloadOutlined /></template></a-button></a-space>
    </div>
    <a-alert v-if="unavailableReason" type="warning" :message="unavailableReason" show-icon class="section-gap" />
    <a-alert v-if="error" type="error" :message="error" show-icon closable class="section-gap" @close="error = ''" />

    <div class="upload-grid">
      <a-card title="上传与处理" class="upload-card">
        <a-form layout="vertical" @finish="submit">
          <a-form-item label="处理方式" required>
            <a-radio-group v-model:value="selectedProcessingMode" :disabled="uploading" class="processing-selector" aria-label="处理方式">
              <a-space direction="vertical" :size="16" class="full-width">
                <a-radio v-for="mode in processingModes" :key="mode.value" :value="mode.value">
                  {{ mode.label }}<a-tag v-if="config && !processingModeAvailable(config, mode.value)" class="inline-tag">未就绪</a-tag>
                  <div class="processing-choice-description">{{ mode.description }}</div>
                </a-radio>
              </a-space>
            </a-radio-group>
            <div v-if="selectedProcessingMode === 'pdf2zh'" class="field-help">pdf2zh 流程使用 BabelDOC 内核，无需 MinerU 密钥；上传后检查文本层，不支持扫描件。</div>
          </a-form-item>
          <a-form-item label="选择文档" required :validate-status="fileValidation ? 'error' : undefined" :help="fileValidation || undefined">
            <a-upload-dragger :before-upload="chooseFile" :show-upload-list="false" :multiple="false" :accept="allowedExtensions.join(',')" :disabled="uploading || !config">
              <p class="ant-upload-drag-icon"><FileTextOutlined v-if="file" /><InboxOutlined v-else /></p>
              <p class="ant-upload-text file-name">{{ file ? file.name : '点击选择文件，或拖动文件到这里' }}</p>
              <p class="ant-upload-hint">{{ file ? formatSize(file.size) + ' · 点击可更换' : selectedMode.fileHint }}</p>
              <p class="ant-upload-hint">单个文件最大 {{ config?.max_upload_mb || 200 }} MB</p>
            </a-upload-dragger>
          </a-form-item>
          <a-form-item label="文档标题" extra="仅用于页面展示与下载命名，不影响服务器上的安全存储名称。">
            <a-input v-model:value="title" placeholder="默认使用文件名，可填写中文" :maxlength="300" :disabled="uploading" />
          </a-form-item>
          <a-form-item label="中文翻译档位" required>
            <a-radio-group v-model:value="selectedTranslationTier" button-style="solid" size="large" class="translation-selector" :disabled="uploading">
              <a-radio-button v-for="tier in translationTiers" :key="tier.tier" :value="tier.tier" :disabled="!tierAvailable(tier.tier)">{{ tier.name }}</a-radio-button>
            </a-radio-group>
            <div class="field-help">{{ selectedTier.engine }} · {{ selectedTier.detail }}</div>
            <div class="field-help">两种处理方式共用以上档位及管理员设置的翻译参数。</div>
            <div v-if="!config?.google_configured || !config?.deepseek_configured" class="field-help">灰色档位需管理员配置对应服务密钥后开放。</div>
          </a-form-item>
          <a-progress v-if="uploading" :percent="uploadProgress" :status="uploadProgress === 100 ? 'active' : 'normal'" />
          <div v-if="uploading" class="field-help section-gap">{{ uploadProgress === 100 ? '文件上传完成，正在保存并创建任务…' : '正在上传文件，请暂时保留此页面。' }}</div>
          <a-button type="primary" size="large" html-type="submit" :loading="uploading" :disabled="!canSubmit"><template #icon><CloudUploadOutlined /></template>{{ uploading ? '正在提交' : '开始处理' }}</a-button>
        </a-form>
      </a-card>

      <div class="side-stack">
        <a-card title="处理说明" size="small">
          <a-steps direction="vertical" size="small" :current="-1" :items="processingSteps" />
        </a-card>
        <a-alert type="info" show-icon message="默认私有">
          <template #icon><LockOutlined /></template>
          <template #description>文档仅当前上传浏览器和管理员可见。公开文库只展示管理员主动公开的文档。</template>
        </a-alert>
        <a-alert type="info" show-icon message="提交后可以离开页面" description="任务由后台持续处理，源文件与处理结果永久保留。" />
      </div>
    </div>

    <a-card v-if="recent.length" title="最近公开文档" class="section-top">
      <template #extra><router-link to="/library">查看全部</router-link></template>
      <a-list :data-source="recent"><template #renderItem="{ item }"><DocumentCard :document="item" /></template></a-list>
    </a-card>
  </div>
</template>
