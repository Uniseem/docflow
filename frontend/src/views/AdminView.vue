<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Descriptions as ADescriptions, DescriptionsItem as ADescriptionsItem, Divider as ADivider, InputNumber as AInputNumber, Modal as AModal, Pagination as APagination, Popconfirm as APopconfirm, Select as ASelect, Table as ATable, Tabs as ATabs, TabPane as ATabPane } from 'ant-design-vue'
import { LogoutOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons-vue'
import { api, ApiError } from '../api'
import StatusChip from '../components/StatusChip.vue'
import { processingModeLabel } from '../processingModes'
import { copyTranslationRuntime, validateTranslationRuntime } from '../translationRuntime'
import type { AdminSettings, DocumentSummary, TranslationRuntime } from '../types'

type TranslationTier = 1 | 2 | 3
const token = ref(localStorage.getItem('docflow-admin-token') || '')
const initialized = ref<boolean | null>(null)
const username = ref('')
const password = ref('')
const passwordConfirm = ref('')
const settings = ref<AdminSettings | null>(null)
const runtime = ref<TranslationRuntime | null>(null)
const tab = ref('translation')
const mineruKey = ref('')
const mineruModel = ref('vlm')
const googleKey = ref('')
const deepseekKey = ref('')
const deepseekModel = ref('deepseek-v4-flash')
const translationTier = ref<TranslationTier>(1)
const r2 = reactive({ accountId: '', accessKeyId: '', secretAccessKey: '', bucket: '', publicBaseUrl: '' })
const documents = ref<DocumentSummary[]>([])
const documentQuery = ref('')
const documentPage = ref(1)
const documentTotal = ref(0)
const documentsLoading = ref(false)
const renameId = ref('')
const renameTitle = ref('')
const renameFilename = ref('')
const pending = ref('')
const loading = ref(false)
const success = ref('')
const error = ref('')
let documentRequest = 0
let recoveryDraft: TranslationRuntime | null = null

const runtimeDirty = computed(() => Boolean(runtime.value && settings.value && JSON.stringify(runtime.value) !== JSON.stringify(settings.value.translation_runtime)))
const runtimeErrors = computed(() => runtime.value && settings.value ? validateTranslationRuntime(runtime.value, settings.value.translation_runtime_limits) : [])
const promptLength = computed(() => Array.from(runtime.value?.system_prompt || '').length)
const tierDirty = computed(() => settings.value && translationTier.value !== settings.value.translation_tier)
const poolDefinitions = [{ key: 'google', name: 'Google Cloud', description: '极速档 · 独立全站任务池' }, { key: 'deepseek', name: 'DeepSeek', description: '均衡与精准档 · 共用全站任务池' }] as const
const tiers = [{ value: 1, label: '极速 · Google' }, { value: 2, label: '均衡 · DeepSeek 非思考' }, { value: 3, label: '精准 · DeepSeek 思考' }] as const
const documentColumns = [
  { title: '文档', key: 'document', width: 340 },
  { title: '处理方式', key: 'processing_mode', width: 160 },
  { title: '状态', key: 'status', width: 120 },
  { title: '可见性', key: 'visibility', width: 90 },
  { title: '创建时间', dataIndex: 'created_at', key: 'date', width: 170 },
  { title: '操作', key: 'actions', width: 290 },
]
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value))
function tierAvailable(tier: TranslationTier) { return tier === 1 ? Boolean(settings.value?.google_configured) : Boolean(settings.value?.deepseek_configured) }

function hydrateSettings(value: AdminSettings) {
  settings.value = value
  mineruModel.value = value.mineru_model
  deepseekModel.value = value.deepseek_model
  translationTier.value = value.translation_tier
  r2.accountId = value.r2_account_id
  r2.bucket = value.r2_bucket
  r2.publicBaseUrl = value.r2_public_base_url
  runtime.value = copyTranslationRuntime(value.translation_runtime)
  if (recoveryDraft) {
    runtime.value = copyTranslationRuntime(recoveryDraft)
    recoveryDraft = null
    success.value = '已重新登录，并恢复本页未保存的翻译配置；请确认后保存。'
  }
}

function clearAdminState() {
  localStorage.removeItem('docflow-admin-token')
  token.value = ''
  settings.value = null
  runtime.value = null
  documents.value = []
  documentRequest += 1
  documentsLoading.value = false
  mineruKey.value = ''; googleKey.value = ''; deepseekKey.value = ''
  r2.accessKeyId = ''; r2.secretAccessKey = ''
  password.value = ''; passwordConfirm.value = ''
  cancelRename()
}

function reportFailure(reason: unknown, fallback: string) {
  if (reason instanceof ApiError && reason.status === 401) {
    if (runtimeDirty.value && runtime.value) recoveryDraft = copyTranslationRuntime(runtime.value)
    clearAdminState()
    success.value = ''
    error.value = '管理员登录已过期，请重新登录。' + (recoveryDraft ? '本页未保存的翻译配置会在重新登录后恢复。' : '')
    return
  }
  // Temporary network/5xx failures must not delete a valid login or form draft.
  error.value = reason instanceof Error ? reason.message : fallback
}

async function loadDocuments() {
  const request = ++documentRequest
  documentsLoading.value = true
  try {
    const result = await api.adminListDocuments(documentPage.value, 20, documentQuery.value.trim())
    if (request !== documentRequest || !token.value) return
    documents.value = result.items
    documentTotal.value = result.total
  } catch (reason) {
    if (request === documentRequest) reportFailure(reason, '无法读取文档')
  } finally {
    if (request === documentRequest) documentsLoading.value = false
  }
}
function searchDocuments() { documentPage.value = 1; void loadDocuments() }
function changeDocumentPage(page: number) { documentPage.value = page; void loadDocuments() }

async function loadSettings() {
  if (!token.value) return
  loading.value = true
  try {
    await api.ensureAdminSession()
    hydrateSettings(await api.adminSettings())
    await loadDocuments()
  } catch (reason) {
    reportFailure(reason, '无法读取后台配置，请稍后重试')
  } finally { loading.value = false }
}

async function authenticate() {
  if (pending.value) return
  error.value = ''
  if (!initialized.value && password.value !== passwordConfirm.value) { error.value = '两次输入的密码不一致'; return }
  pending.value = 'auth'
  try {
    const result = initialized.value ? await api.adminLogin(username.value, password.value) : await api.adminRegister(username.value, password.value)
    localStorage.setItem('docflow-admin-token', result.token)
    token.value = result.token
    initialized.value = true
    password.value = ''
    passwordConfirm.value = ''
    await loadSettings()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '登录失败'
    const status = await api.adminStatus().catch(() => null)
    if (status) initialized.value = status.initialized
  } finally { pending.value = '' }
}

async function logout() {
  if (pending.value) return
  pending.value = 'logout'
  await api.adminLogout().catch(() => undefined)
  clearAdminState()
  recoveryDraft = null
  success.value = ''; error.value = ''; pending.value = ''
}

async function saveAction(name: string, action: () => Promise<AdminSettings>, done: string, clear?: () => void) {
  if (pending.value) return
  pending.value = name; error.value = ''; success.value = ''
  try {
    settings.value = await action()
    clear?.()
    success.value = done
  } catch (reason) {
    reportFailure(reason, '保存失败')
  } finally { pending.value = '' }
}
function saveMinerU() { return saveAction('mineru', () => api.saveMinerU(mineruKey.value, mineruModel.value), 'MinerU 验证成功，密钥已加密保存。', () => { mineruKey.value = '' }) }
function saveGoogle() { return saveAction('google', () => api.saveGoogle(googleKey.value), 'Google Cloud 验证成功，极速档已开放。', () => { googleKey.value = '' }) }
function saveDeepSeek() { return saveAction('deepseek', () => api.saveDeepSeek(deepseekKey.value, deepseekModel.value), 'DeepSeek 验证成功，均衡与精准档已开放。', () => { deepseekKey.value = '' }) }
function saveTier() { return saveAction('tier', () => api.saveTranslationTier(translationTier.value), '全站默认档位已保存；用户仍可选择其他已开放档位。') }
function saveR2() { return saveAction('r2', () => api.saveR2(r2.accountId, r2.accessKeyId, r2.secretAccessKey, r2.bucket, r2.publicBaseUrl), 'R2 存储桶已验证，本地归档后会追加异地镜像。', () => { r2.accessKeyId = ''; r2.secretAccessKey = '' }) }

async function saveRuntime() {
  if (!runtime.value || runtimeErrors.value.length) { error.value = runtimeErrors.value.join('；'); return }
  const submitted = copyTranslationRuntime(runtime.value)
  await saveAction('runtime', () => api.saveTranslationRuntime(submitted), '翻译配置已保存。两个任务池的并发限制约 2 秒内用于新发请求；段长、批量、单篇在途请求数与提示词用于新任务和管理员手动重试。', () => {
    if (settings.value) runtime.value = copyTranslationRuntime(settings.value.translation_runtime)
  })
}
function resetRuntimeDefaults() {
  if (!settings.value) return
  runtime.value = copyTranslationRuntime(settings.value.translation_runtime_defaults)
  success.value = ''; error.value = ''
}
function discardRuntimeChanges() {
  if (settings.value) runtime.value = copyTranslationRuntime(settings.value.translation_runtime)
}

function beginRename(item: DocumentSummary) { renameId.value = item.id; renameTitle.value = item.title; renameFilename.value = item.display_filename }
function cancelRename() { renameId.value = ''; renameTitle.value = ''; renameFilename.value = '' }
async function mutateDocument(name: string, action: () => Promise<DocumentSummary>, notice: string) {
  if (pending.value) return
  pending.value = name; error.value = ''; success.value = ''
  try {
    const updated = await action()
    documents.value = documents.value.map((item) => item.id === updated.id ? updated : item)
    success.value = notice
    if (name === 'rename') cancelRename()
  } catch (reason) {
    reportFailure(reason, '操作失败')
  } finally { pending.value = '' }
}
function saveNames() { return mutateDocument('rename', () => api.updateDocumentNames(renameId.value, renameTitle.value, renameFilename.value), '展示标题和下载文件名已更新，服务器物理名称不变。') }
function toggleVisibility(item: DocumentSummary) { return mutateDocument(item.id, () => api.updateDocumentVisibility(item.id, !item.is_public), item.is_public ? '文档已设为私有，匿名访问已关闭。' : '文档已公开，匿名用户可以查看并下载。') }
function retryDocument(item: DocumentSummary) { return mutateDocument(item.id, () => api.retryDocument(item.id), '任务已重新排队，使用最新翻译配置；源文件始终保留。') }

async function initialize() {
  error.value = ''
  try { initialized.value = (await api.adminStatus()).initialized; await loadSettings() }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '无法连接管理服务' }
}
onMounted(initialize)
</script>

<template>
  <div class="page-container admin-container">
    <div class="page-heading"><div><h1>管理后台</h1><p>管理翻译参数、服务密钥与全部文档。</p></div><a-button v-if="token" :loading="pending === 'logout'" :disabled="Boolean(pending)" @click="logout()"><template #icon><LogoutOutlined /></template>退出登录</a-button></div>
    <a-alert v-if="success" type="success" :message="success" show-icon closable class="section-gap" @close="success = ''" />
    <a-alert v-if="error" type="error" :message="error" show-icon closable class="section-gap" @close="error = ''" />
    <a-card v-if="!loading && error && (initialized === null || (token && !settings))" class="section-gap"><a-button type="primary" @click="initialize"><template #icon><ReloadOutlined /></template>重新连接后台</a-button></a-card>
    <div v-else-if="initialized === null || loading" class="loading-state"><a-spin /><span>正在读取后台配置…</span></div>

    <a-card v-else-if="!token" :title="initialized ? '管理员登录' : '注册首位管理员'" class="auth-card">
      <a-alert v-if="!initialized" type="warning" show-icon message="首位完成注册的用户将成为管理员，注册后初始化入口关闭。" class="section-gap" />
      <a-form layout="vertical" @finish="authenticate">
        <a-form-item label="管理员名称" required><a-input v-model:value="username" autocomplete="username" :maxlength="64" /></a-form-item>
        <a-form-item label="管理员密码" required :extra="initialized ? '' : '至少 10 个字符，请妥善保存。'"><a-input-password v-model:value="password" :autocomplete="initialized ? 'current-password' : 'new-password'" /></a-form-item>
        <a-form-item v-if="!initialized" label="确认密码" required><a-input-password v-model:value="passwordConfirm" autocomplete="new-password" /></a-form-item>
        <a-button type="primary" html-type="submit" block :loading="pending === 'auth'" :disabled="username.trim().length < 2 || !password || (!initialized && password.length < 10)">{{ initialized ? '登录' : '注册并进入后台' }}</a-button>
      </a-form>
    </a-card>

    <template v-else-if="settings">
      <a-space wrap class="section-gap"><a-tag :color="settings.mineru_configured ? 'success' : 'warning'">MinerU {{ settings.mineru_configured ? '已配置' : '未配置' }}</a-tag><a-tag :color="settings.google_configured ? 'success' : 'default'">Google {{ settings.google_configured ? '已配置' : '未配置' }}</a-tag><a-tag :color="settings.deepseek_configured ? 'success' : 'default'">DeepSeek {{ settings.deepseek_configured ? '已配置' : '未配置' }}</a-tag><a-tag color="success">本地存储已启用</a-tag></a-space>
      <a-tabs v-model:active-key="tab" class="admin-tabs">
        <a-tab-pane key="translation" tab="翻译设置">
          <a-card title="默认翻译档位" class="section-gap">
            <p class="section-description">MinerU 解析翻译与 PDF 原生翻译共用以下档位、服务密钥、并发参数和提示词。上传页默认选择此档位，用户可以为单次任务切换其他已开放档位。</p>
            <a-space wrap><a-radio-group v-model:value="translationTier" button-style="solid" :disabled="Boolean(pending)"><a-radio-button v-for="tier in tiers" :key="tier.value" :value="tier.value" :disabled="!tierAvailable(tier.value)">{{ tier.label }}</a-radio-button></a-radio-group><a-button type="primary" :disabled="!tierDirty || Boolean(pending)" :loading="pending === 'tier'" @click="saveTier">保存默认档位</a-button></a-space>
          </a-card>

          <a-card v-if="runtime" title="并发与分段" class="section-gap">
            <template #extra><a-tag v-if="runtimeDirty" color="warning">有未保存的修改</a-tag></template>
            <a-alert type="info" show-icon message="两个独立的全站任务池" description="Google 与 DeepSeek 分别控制并发，两种处理方式、所有用户共享对应任务池。每次请求最多段数指单次 API 批量提交，不是整篇文档的总段数。" class="section-gap" />
            <a-form layout="vertical" :disabled="Boolean(pending)" @finish="saveRuntime">
              <div class="provider-grid">
                <a-card v-for="pool in poolDefinitions" :key="pool.key" size="small" :title="pool.name">
                  <p class="section-description">{{ pool.description }}</p>
                  <a-form-item :label="pool.name + ' 并发请求数'" :extra="`1–${settings.translation_runtime_limits[pool.key].concurrency_max} 路；按全站计算。`">
                    <a-input-number v-model:value="runtime[pool.key].concurrency" :min="1" :max="settings.translation_runtime_limits[pool.key].concurrency_max" :precision="0" class="full-width" />
                  </a-form-item>
                  <a-form-item :label="pool.name + ' 每段最大字符数'" :extra="`${settings.translation_runtime_limits.min_chunk_chars}–${settings.translation_runtime_limits[pool.key].chunk_chars_max} 字符，含空格与标点。`">
                    <a-input-number v-model:value="runtime[pool.key].chunk_chars" :min="settings.translation_runtime_limits.min_chunk_chars" :max="settings.translation_runtime_limits[pool.key].chunk_chars_max" :precision="0" class="full-width" />
                  </a-form-item>
                  <a-form-item :label="pool.name + ' 每次请求最多段数'" :extra="`1–${settings.translation_runtime_limits[pool.key].max_segments_per_request_max} 段；实际批次可能因总长度预算进一步缩小。`">
                    <a-input-number v-model:value="runtime[pool.key].max_segments_per_request" :min="1" :max="settings.translation_runtime_limits[pool.key].max_segments_per_request_max" :precision="0" class="full-width" />
                  </a-form-item>
                  <p class="field-help">{{ pool.key === 'google' ? 'Google 的并发上限为本应用安全阈值，并非官方并发配额。官方字符与请求速率配额仍单独生效。' : 'DeepSeek 上限保留官方并发额度的 20% 余量；请根据 VPS 能力与账号额度设置。' }}</p>
                </a-card>
              </div>
              <a-form-item label="单篇文档最大在途请求数" :extra="`1–${settings.translation_runtime_limits.per_document_concurrency_max} 路，防止单篇长文档独占任务池；还受对应全站池限制。`" class="section-top">
                <a-input-number v-model:value="runtime.per_document_concurrency" :min="1" :max="settings.translation_runtime_limits.per_document_concurrency_max" :precision="0" class="medium-input" />
              </a-form-item>
              <a-divider />
              <a-form-item label="全局翻译提示词" required extra="两种处理方式共用；用于每次 DeepSeek 均衡、精准翻译调用及其重试。Google Basic API 不支持提示词，此设置不作用于 Google。">
                <a-textarea v-model:value="runtime.system_prompt" :auto-size="{ minRows: 9, maxRows: 24 }" placeholder="填写全站统一的中文翻译要求，例如术语、语气、忠实度等。" class="prompt-input" />
                <div class="field-help">{{ promptLength }} / {{ settings.translation_runtime_limits.system_prompt_max_chars }} 字符</div>
              </a-form-item>
              <a-alert type="info" show-icon message="提示词可编辑，结构保护协议始终保留" description="程序会按处理方式附加 Markdown 或 PDF 文本的结构、公式与占位符保护，以及批次 JSON 返回协议，避免修改正文结构或丢失分段。" class="section-gap" />
              <a-alert v-if="runtimeErrors.length" type="error" :message="runtimeErrors.join('；')" show-icon class="section-gap" />
              <a-space wrap>
                <a-button type="primary" html-type="submit" :loading="pending === 'runtime'" :disabled="!runtimeDirty || runtimeErrors.length > 0 || Boolean(pending)"><template #icon><SaveOutlined /></template>保存翻译配置</a-button>
                <a-button :disabled="!runtimeDirty || Boolean(pending)" @click="discardRuntimeChanges">撤销修改</a-button>
                <a-popconfirm title="将表单填入默认值？仍需点击保存后才会生效。" ok-text="填入默认值" @confirm="resetRuntimeDefaults"><a-button :disabled="Boolean(pending)">填入默认值</a-button></a-popconfirm>
              </a-space>
              <p class="field-help section-top">两个任务池的并发调整约 2 秒内对新发请求生效，无需重启，也不会取消已发请求。段长、批量、单篇在途请求数和提示词在新任务创建时固定；自动重试沿用原配置，管理员手动重试采用最新配置。</p>
            </a-form>
          </a-card>
        </a-tab-pane>

        <a-tab-pane key="credentials" tab="服务密钥">
          <a-alert type="info" show-icon message="密钥加密保存在数据库中，页面只显示掩码。验证成功后才会开放相应服务。" class="section-gap" />
          <div class="credential-grid">
            <a-card title="MinerU 文档解析">
              <p class="section-description">仅用于 MinerU 解析翻译。PDF 原生翻译使用 BabelDOC 内核，无需此密钥。</p>
              <a-form layout="vertical" @finish="saveMinerU">
                <a-form-item label="新的 MinerU API Key" :extra="settings.mineru_api_key_masked ? '当前：' + settings.mineru_api_key_masked : '尚未配置'"><a-input-password v-model:value="mineruKey" autocomplete="new-password" /></a-form-item>
                <a-form-item label="解析模型"><a-select v-model:value="mineruModel" :options="[{ label: 'VLM（推荐）', value: 'vlm' }, { label: 'Pipeline', value: 'pipeline' }]" /></a-form-item>
                <a-button type="primary" html-type="submit" :loading="pending === 'mineru'" :disabled="mineruKey.length < 8 || Boolean(pending)">验证并保存</a-button>
              </a-form>
            </a-card>
            <a-card title="Google Cloud Translation">
              <p class="section-description">极速档使用官方 Basic v2 API，需启用 API 并配置项目密钥。</p>
              <a-form layout="vertical" @finish="saveGoogle">
                <a-form-item label="新的 Google API Key" :extra="settings.google_api_key_masked ? '当前：' + settings.google_api_key_masked : '尚未配置'"><a-input-password v-model:value="googleKey" autocomplete="new-password" /></a-form-item>
                <a-button type="primary" html-type="submit" :loading="pending === 'google'" :disabled="googleKey.length < 8 || Boolean(pending)">验证并保存</a-button>
              </a-form>
            </a-card>
            <a-card title="DeepSeek">
              <a-form layout="vertical" @finish="saveDeepSeek">
                <a-form-item label="新的 DeepSeek API Key" :extra="settings.deepseek_api_key_masked ? '当前：' + settings.deepseek_api_key_masked : '尚未配置'"><a-input-password v-model:value="deepseekKey" autocomplete="new-password" /></a-form-item>
                <a-form-item label="模型名称" extra="均衡档关闭思考，精准档启用思考。"><a-input v-model:value="deepseekModel" placeholder="deepseek-v4-flash" /></a-form-item>
                <a-button type="primary" html-type="submit" :loading="pending === 'deepseek'" :disabled="deepseekKey.length < 8 || !deepseekModel.trim() || Boolean(pending)">验证并保存</a-button>
              </a-form>
            </a-card>
          </div>
        </a-tab-pane>

        <a-tab-pane key="documents" tab="文档管理">
          <a-card title="全部文档">
            <p class="section-description">包含所有私有与公开文档。新文档默认私有，公开后匿名访问者可阅读和下载。</p>
            <div class="table-toolbar"><a-input-search v-model:value="documentQuery" placeholder="按标题或文件名搜索" aria-label="搜索后台全部文档" enter-button="搜索" allow-clear class="search-input" @search="searchDocuments" /><a-button :loading="documentsLoading" @click="loadDocuments"><template #icon><ReloadOutlined /></template>刷新</a-button></div>
            <a-table :columns="documentColumns" :data-source="documents" row-key="id" :pagination="false" :loading="documentsLoading" :scroll="{ x: 1170 }" size="middle">
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'document'"><router-link :to="`/documents/${record.id}`" class="table-document-title">{{ record.title }}</router-link><div class="field-help file-name">{{ record.display_filename }}</div></template>
                <template v-else-if="column.key === 'processing_mode'"><a-tag :color="record.processing_mode === 'pdf2zh' ? 'cyan' : 'default'">{{ processingModeLabel(record.processing_mode) }}</a-tag></template>
                <template v-else-if="column.key === 'status'"><StatusChip :status="record.status" /><a-progress v-if="['processing', 'queued', 'retrying'].includes(record.status)" :percent="record.progress" size="small" /></template>
                <template v-else-if="column.key === 'visibility'"><a-tag :color="record.is_public ? 'blue' : 'default'">{{ record.is_public ? '公开' : '私有' }}</a-tag></template>
                <template v-else-if="column.key === 'date'">{{ formatDate(record.created_at) }}</template>
                <template v-else-if="column.key === 'actions'">
                  <a-space wrap size="small">
                    <router-link :to="`/documents/${record.id}`">查看</router-link>
                    <a :href="`/api/v1/jobs/${record.id}/bundle`">下载</a>
                    <a-button type="link" size="small" @click="beginRename(record as DocumentSummary)">重命名</a-button>
                    <a-popconfirm :title="record.is_public ? '设为私有并关闭匿名访问？' : '公开后所有访客均可查看与下载，确定公开？'" @confirm="toggleVisibility(record as DocumentSummary)"><a-button type="link" size="small" :disabled="Boolean(pending)">{{ record.is_public ? '设为私有' : '公开' }}</a-button></a-popconfirm>
                    <a-popconfirm v-if="record.status === 'failed'" title="使用最新翻译配置重新处理此文档？" @confirm="retryDocument(record as DocumentSummary)"><a-button type="link" size="small" :loading="pending === record.id" :disabled="Boolean(pending)">重试</a-button></a-popconfirm>
                  </a-space>
                </template>
              </template>
            </a-table>
            <a-pagination :current="documentPage" :page-size="20" :total="documentTotal" :show-size-changer="false" :show-total="(count: number) => `共 ${count} 份文档`" class="table-pagination" @change="changeDocumentPage" />
          </a-card>
        </a-tab-pane>

        <a-tab-pane key="storage" tab="存储与备份">
          <a-card title="本地永久存储" class="section-gap">
            <a-descriptions bordered :column="1" size="small">
              <a-descriptions-item label="主存储">始终启用，源文件与处理清单永久保留。MinerU 流程归档 Markdown、期刊式 PDF、HTML 和 WebP；PDF 原生流程归档中文单语与双语 PDF。</a-descriptions-item>
              <a-descriptions-item label="文件命名">使用 UUID 目录与 ASCII 物理文件名，展示名称由数据库映射，不直接重命名磁盘文件。</a-descriptions-item>
              <a-descriptions-item label="迁移">可下载单篇文档的完整归档；迁移实例需同时备份数据库、文件目录与 data/config。</a-descriptions-item>
            </a-descriptions>
          </a-card>
          <a-card title="Cloudflare R2 镜像（可选）">
            <template #extra><a-tag :color="settings.r2_configured ? 'success' : 'default'">{{ settings.r2_configured ? '已配置' : '未配置' }}</a-tag></template>
            <p class="section-description">只追加异地副本，R2 故障不影响本地发布，也不会删除本地文件。</p>
            <a-alert type="warning" show-icon message="请使用私有存储桶" description="镜像包含私有文档。请关闭桶的公开访问、r2.dev 和公开自定义域名；文件必须通过本站鉴权下载，否则知道对象地址的人仍可绕过本站访问。" class="section-gap" />
            <a-form layout="vertical" @finish="saveR2">
              <div class="provider-grid"><a-form-item label="Cloudflare Account ID"><a-input v-model:value="r2.accountId" /></a-form-item><a-form-item label="Bucket 名称"><a-input v-model:value="r2.bucket" /></a-form-item><a-form-item label="新的 Access Key ID"><a-input-password v-model:value="r2.accessKeyId" autocomplete="new-password" :placeholder="settings.r2_access_key_id_masked || ''" /></a-form-item><a-form-item label="新的 Secret Access Key"><a-input-password v-model:value="r2.secretAccessKey" autocomplete="new-password" :placeholder="settings.r2_secret_access_key_masked || ''" /></a-form-item></div>
              <a-form-item label="旧版公开域名（兼容字段，建议留空）"><a-input v-model:value="r2.publicBaseUrl" placeholder="请关闭桶的公开访问，并留空此项" /></a-form-item>
              <a-button type="primary" html-type="submit" :loading="pending === 'r2'" :disabled="!r2.accountId || !r2.bucket || r2.accessKeyId.length < 8 || r2.secretAccessKey.length < 8 || Boolean(pending)">验证并保存</a-button>
            </a-form>
          </a-card>
        </a-tab-pane>
      </a-tabs>
    </template>

    <a-modal :open="Boolean(renameId)" title="重命名文档" ok-text="保存" :confirm-loading="pending === 'rename'" :ok-button-props="{ disabled: !renameTitle.trim() || !renameFilename.trim() || Boolean(pending) }" @ok="saveNames" @cancel="cancelRename">
      <p class="section-description">只修改数据库中的展示名称，不移动服务器文件。</p>
      <a-form layout="vertical"><a-form-item label="网页展示标题" required><a-input v-model:value="renameTitle" :maxlength="512" /></a-form-item><a-form-item label="源文件下载名称" required extra="保留原文件扩展名，可使用中文与空格。"><a-input v-model:value="renameFilename" :maxlength="512" /></a-form-item></a-form>
    </a-modal>
  </div>
</template>
