<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { api } from '../api'
import type { AdminSettings, DocumentSummary } from '../types'

type TranslationTier = 1 | 2 | 3 | 4

const translationTiers: Array<{
  tier: TranslationTier
  name: string
  engine: string
  description: string
  meta: string
  icon: string
}> = [
  { tier: 1, name: '极速', engine: 'Google', description: '免费分块直译，适合快速获取中文内容。', meta: '最快 · 免费', icon: 'mdi-flash-outline' },
  { tier: 2, name: '标准', engine: 'DeepSeek', description: '大模型分块翻译，表达更自然，术语处理更稳。', meta: '较快 · 按量计费', icon: 'mdi-translate' },
  { tier: 3, name: '精细', engine: 'DeepSeek', description: '先速览全文并生成统一约束，再逐块执行翻译。', meta: '较慢 · 全文一致', icon: 'mdi-book-open-page-variant-outline' },
  { tier: 4, name: 'Agent', engine: 'DeepSeek', description: '通读全文建立蓝图，携带前后文逐段翻译。', meta: '最慢 · 质量最高', icon: 'mdi-robot-outline' },
]

const token = ref(localStorage.getItem('docflow-admin-token') || '')
const initialized = ref<boolean | null>(null)
const username = ref('')
const password = ref('')
const passwordConfirm = ref('')
const settings = ref<AdminSettings | null>(null)
const mineruKey = ref('')
const mineruModel = ref('vlm')
const deepseekKey = ref('')
const deepseekModel = ref('deepseek-v4-flash')
const translationTier = ref<TranslationTier>(1)
const r2AccountId = ref('')
const r2AccessKeyId = ref('')
const r2SecretAccessKey = ref('')
const r2Bucket = ref('')
const r2PublicBaseUrl = ref('')
const documents = ref<DocumentSummary[]>([])
const documentQuery = ref('')
const renameId = ref('')
const renameTitle = ref('')
const renameFilename = ref('')
const loading = ref(false)
const message = ref('')
const error = ref('')
const hasPendingTranslationTier = computed(() => Boolean(settings.value && translationTier.value !== settings.value.translation_tier))

const filteredDocuments = computed(() => {
  const query = documentQuery.value.trim().toLocaleLowerCase()
  if (!query) return documents.value
  return documents.value.filter((document) => `${document.title} ${document.display_filename}`.toLocaleLowerCase().includes(query))
})

async function loadSettings() {
  if (!token.value) return
  try {
    await api.ensureAdminSession()
    settings.value = await api.adminSettings()
    mineruModel.value = settings.value.mineru_model
    deepseekModel.value = settings.value.deepseek_model
    translationTier.value = settings.value.translation_tier
    r2AccountId.value = settings.value.r2_account_id
    r2Bucket.value = settings.value.r2_bucket
    r2PublicBaseUrl.value = settings.value.r2_public_base_url
    documents.value = (await api.adminListDocuments(1, 100)).items
  } catch {
    await logout()
  }
}

async function login() {
  loading.value = true
  error.value = ''
  try {
    const result = await api.adminLogin(username.value, password.value)
    localStorage.setItem('docflow-admin-token', result.token)
    token.value = result.token
    password.value = ''
    await loadSettings()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '登录失败'
  } finally {
    loading.value = false
  }
}

async function register() {
  error.value = ''
  if (password.value !== passwordConfirm.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  loading.value = true
  try {
    const result = await api.adminRegister(username.value, password.value)
    localStorage.setItem('docflow-admin-token', result.token)
    token.value = result.token
    initialized.value = true
    password.value = ''
    passwordConfirm.value = ''
    await loadSettings()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '注册失败'
    const status = await api.adminStatus().catch(() => null)
    if (status) initialized.value = status.initialized
  } finally {
    loading.value = false
  }
}

async function logout() {
  await api.adminLogout().catch(() => undefined)
  localStorage.removeItem('docflow-admin-token')
  token.value = ''
  settings.value = null
}

async function saveMinerU() {
  error.value = ''; message.value = ''; loading.value = true
  try {
    settings.value = await api.saveMinerU(mineruKey.value, mineruModel.value)
    mineruKey.value = ''
    message.value = 'MinerU 连接验证成功，配置已加密保存。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存失败'
  } finally { loading.value = false }
}

async function saveDeepSeek() {
  error.value = ''; message.value = ''; loading.value = true
  try {
    settings.value = await api.saveDeepSeek(deepseekKey.value, deepseekModel.value)
    deepseekKey.value = ''
    message.value = 'DeepSeek 验证成功。上传页现在会开放第 2–4 档；保存 Key 不会自动切换默认档位。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存失败'
  } finally { loading.value = false }
}

function selectTranslationTier(tier: TranslationTier) {
  if (tier > 1 && !settings.value?.deepseek_configured) {
    error.value = '第 2–4 档需要先在下方配置并验证 DeepSeek API Key 与模型。'
    document.querySelector('#deepseek')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  error.value = ''
  message.value = ''
  translationTier.value = tier
}

async function saveTranslator() {
  error.value = ''; message.value = ''; loading.value = true
  try {
    settings.value = await api.saveTranslationTier(translationTier.value)
    translationTier.value = settings.value.translation_tier
    message.value = `默认翻译档位已切换为第 ${translationTier.value} 档；用户仍可在上传时选择其他已开放档位。`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存失败'
  } finally { loading.value = false }
}

async function saveR2() {
  error.value = ''; message.value = ''; loading.value = true
  try {
    settings.value = await api.saveR2(r2AccountId.value, r2AccessKeyId.value, r2SecretAccessKey.value, r2Bucket.value, r2PublicBaseUrl.value)
    r2AccessKeyId.value = ''
    r2SecretAccessKey.value = ''
    message.value = 'R2 存储桶验证成功，新任务会在本地归档后追加镜像。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存失败'
  } finally { loading.value = false }
}

function beginRename(document: DocumentSummary) {
  renameId.value = document.id
  renameTitle.value = document.title
  renameFilename.value = document.display_filename
}

function cancelRename() {
  renameId.value = ''
  renameTitle.value = ''
  renameFilename.value = ''
}

async function saveNames() {
  if (!renameId.value) return
  error.value = ''; message.value = ''; loading.value = true
  try {
    const updated = await api.updateDocumentNames(renameId.value, renameTitle.value, renameFilename.value)
    documents.value = documents.value.map((document) => document.id === updated.id ? updated : document)
    cancelRename()
    message.value = '展示标题和下载文件名已更新，服务器物理名称没有变化。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '重命名失败'
  } finally { loading.value = false }
}

async function toggleVisibility(document: DocumentSummary) {
  error.value = ''; message.value = ''; loading.value = true
  try {
    const updated = await api.updateDocumentVisibility(document.id, !document.is_public)
    documents.value = documents.value.map((item) => item.id === updated.id ? updated : item)
    message.value = updated.is_public
      ? '文档已公开，匿名访问者现在可以在公开文库中查看和下载。'
      : '文档已设为私有，匿名访问已立即关闭；管理员仍可查看。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '修改公开状态失败'
  } finally { loading.value = false }
}

onMounted(async () => {
  try {
    initialized.value = (await api.adminStatus()).initialized
    await loadSettings()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法连接管理服务'
  }
})
</script>

<template>
  <v-container class="admin-shell">
    <header class="admin-header">
      <div>
        <span class="admin-kicker">ADMIN</span>
        <h1>管理后台</h1>
        <p>配置全站翻译、存储服务，并查看和公开默认私有的文档。</p>
      </div>
      <v-btn v-if="token" variant="text" prepend-icon="mdi-logout" @click="logout">退出登录</v-btn>
    </header>

    <div v-if="initialized === null" class="state-page state-page--loading"><v-progress-circular indeterminate color="primary" size="30" /><span>正在读取实例状态</span></div>

    <section v-else-if="!token" class="auth-panel">
      <div class="auth-panel__head">
        <span class="auth-icon"><v-icon icon="mdi-shield-lock-outline" size="22" /></span>
        <div><h2>{{ initialized ? '管理员登录' : '注册首位管理员' }}</h2><p>{{ initialized ? '登录后管理解析、翻译和存储配置。' : '第一个完成注册的用户将成为唯一管理员。' }}</p></div>
      </div>
      <v-alert v-if="!initialized" type="warning" variant="tonal" density="compact" class="mb-5">注册成功后初始化入口会永久关闭，请保存好管理员密码。</v-alert>
      <v-text-field v-model="username" label="管理员名称" autocomplete="username" />
      <v-text-field v-model="password" label="管理员密码" type="password" :autocomplete="initialized ? 'current-password' : 'new-password'" @keyup.enter="initialized ? login() : register()" />
      <v-text-field v-if="!initialized" v-model="passwordConfirm" label="再次输入密码" type="password" autocomplete="new-password" hint="至少 10 个字符" persistent-hint @keyup.enter="register" />
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
      <v-btn color="primary" block size="large" :loading="loading" :disabled="username.trim().length < 2 || !password || (!initialized && password.length < 10)" @click="initialized ? login() : register()">
        {{ initialized ? '登录后台' : '注册并进入后台' }}
      </v-btn>
    </section>

    <template v-else-if="settings">
      <v-alert v-if="message" type="success" variant="tonal" density="compact" closable class="admin-notice" @click:close="message = ''">{{ message }}</v-alert>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" closable class="admin-notice" @click:close="error = ''">{{ error }}</v-alert>

      <div class="admin-layout">
        <aside class="admin-sidebar">
          <nav aria-label="后台设置目录">
            <a href="#mineru"><v-icon icon="mdi-file-search-outline" size="17" />MinerU</a>
            <a href="#translation"><v-icon icon="mdi-translate" size="17" />默认翻译</a>
            <a href="#deepseek"><v-icon icon="mdi-key-outline" size="17" />DeepSeek</a>
            <a href="#storage"><v-icon icon="mdi-harddisk" size="17" />本地存储</a>
            <a href="#r2"><v-icon icon="mdi-cloud-outline" size="17" />R2 镜像</a>
            <a href="#documents"><v-icon icon="mdi-file-lock-outline" size="17" />文档管理</a>
          </nav>
          <div class="config-status">
            <h3>服务状态</h3>
            <div><span>MinerU</span><b :class="settings.mineru_configured ? 'ok' : 'warn'">{{ settings.mineru_configured ? '已配置' : '未配置' }}</b></div>
            <div><span>默认档位</span><b class="ok">第 {{ settings.translation_tier }} 档</b></div>
            <div><span>DeepSeek</span><b :class="settings.deepseek_configured ? 'ok' : ''">{{ settings.deepseek_configured ? '已配置' : '未配置' }}</b></div>
            <div><span>本地存储</span><b class="ok">已启用</b></div>
            <div><span>R2</span><b :class="settings.r2_configured ? 'ok' : ''">{{ settings.r2_configured ? '已配置' : '可选' }}</b></div>
          </div>
        </aside>

        <main class="admin-content">
          <section id="mineru" class="settings-section">
            <header><div><h2>MinerU 解析</h2><p>提交文档前必须完成此项配置。</p></div><span class="setting-state" :class="settings.mineru_configured ? 'is-ok' : 'is-warn'">{{ settings.mineru_configured ? '已配置' : '未配置' }}</span></header>
            <p v-if="settings.mineru_api_key_masked" class="current-secret">当前 Key：<code>{{ settings.mineru_api_key_masked }}</code></p>
            <div class="form-grid form-grid--2">
              <v-text-field v-model="mineruKey" label="新的 MinerU API Key" type="password" autocomplete="new-password" hide-details />
              <v-select v-model="mineruModel" label="解析模型" :items="[{ title: 'VLM（推荐）', value: 'vlm' }, { title: 'Pipeline', value: 'pipeline' }]" hide-details />
            </div>
            <div class="form-actions"><v-btn color="primary" :loading="loading" :disabled="mineruKey.length < 8" @click="saveMinerU">验证并保存</v-btn></div>
          </section>

          <section id="translation" class="settings-section">
            <header><div><h2>默认翻译档位</h2><p>上传页会默认选中此档；用户可以为单次任务选择其他已开放档位。</p></div><span class="setting-state is-ok">当前默认：第 {{ settings.translation_tier }} 档</span></header>
            <div class="translation-quality-grid" role="radiogroup" aria-label="默认翻译质量档位">
              <button
                v-for="tier in translationTiers"
                :key="tier.tier"
                type="button"
                class="translation-quality-card"
                :class="{
                  'is-selected': translationTier === tier.tier,
                  'is-current': settings.translation_tier === tier.tier,
                  'is-unavailable': tier.tier > 1 && !settings.deepseek_configured,
                }"
                role="radio"
                :aria-checked="translationTier === tier.tier"
                :aria-disabled="tier.tier > 1 && !settings.deepseek_configured"
                @click="selectTranslationTier(tier.tier)"
              >
                <span class="translation-quality-card__top">
                  <span class="translation-quality-card__number">0{{ tier.tier }}</span>
                  <span class="translation-quality-card__engine">{{ tier.engine }}</span>
                  <v-icon v-if="translationTier === tier.tier" icon="mdi-check-circle" size="22" />
                  <v-icon v-else icon="mdi-circle-outline" size="22" />
                </span>
                <span class="translation-quality-card__body">
                  <span class="translation-quality-card__icon"><v-icon :icon="tier.icon" size="25" /></span>
                  <span><b>{{ tier.name }}</b><small>{{ tier.description }}</small></span>
                </span>
                <span class="translation-quality-card__footer">
                  <span>{{ tier.meta }}</span>
                  <em v-if="settings.translation_tier === tier.tier">当前默认</em>
                  <em v-else-if="tier.tier > 1 && !settings.deepseek_configured">需要 DeepSeek</em>
                  <em v-else>可选择</em>
                </span>
              </button>
            </div>
            <div class="translation-save-bar" :class="{ 'has-change': hasPendingTranslationTier }">
              <span>
                <v-icon :icon="hasPendingTranslationTier ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'" size="21" />
                <span><b>{{ hasPendingTranslationTier ? `已选择第 ${translationTier} 档，尚未保存` : `上传页默认选择第 ${settings.translation_tier} 档` }}</b><small>用户提交时可以切换；最终选择会固定在任务中。</small></span>
              </span>
              <v-btn class="translation-save-button" color="primary" size="large" :loading="loading" :disabled="!hasPendingTranslationTier" @click="saveTranslator">
                {{ hasPendingTranslationTier ? `保存并应用第 ${translationTier} 档` : '当前设置已保存' }}
              </v-btn>
            </div>
            <p class="section-help">第 3–4 档会永久保存全文速览约束或 Agent 蓝图。DeepSeek 配置成功后，上传者可以选择第 2–4 档。</p>
          </section>

          <section id="deepseek" class="settings-section">
            <header><div><h2>DeepSeek 配置</h2><p>配置成功后在上传页开放第 2–4 档，不会自动切换默认档位。</p></div><span class="setting-state" :class="settings.deepseek_configured ? 'is-ok' : ''">{{ settings.deepseek_configured ? '已配置' : '可选' }}</span></header>
            <p v-if="settings.deepseek_api_key_masked" class="current-secret">当前 Key：<code>{{ settings.deepseek_api_key_masked }}</code></p>
            <div class="form-grid form-grid--2">
              <v-text-field v-model="deepseekKey" label="新的 DeepSeek API Key" type="password" autocomplete="new-password" hide-details />
              <v-text-field v-model="deepseekModel" label="模型名称" placeholder="deepseek-v4-flash" hide-details />
            </div>
            <div class="form-actions"><v-btn color="primary" :loading="loading" :disabled="deepseekKey.length < 8 || !deepseekModel" @click="saveDeepSeek">调用模型验证并保存</v-btn></div>
          </section>

          <section id="storage" class="settings-section storage-section">
            <header><div><h2>VPS 本地存储</h2><p>默认主存储，始终启用。</p></div><span class="setting-state is-ok">运行中</span></header>
            <div class="storage-facts">
              <div><v-icon icon="mdi-file-lock-outline" size="18" /><span><b>安全物理名称</b><small>UUID 目录和 ASCII 文件名，避免中文编码问题</small></span></div>
              <div><v-icon icon="mdi-archive-outline" size="18" /><span><b>完整永久归档</b><small>源文件、Markdown、HTML、WebP、MinerU ZIP 和事件清单</small></span></div>
              <div><v-icon icon="mdi-folder-zip-outline" size="18" /><span><b>随时打包迁移</b><small>每份文档均可下载完整归档包</small></span></div>
            </div>
          </section>

          <details id="r2" class="settings-section optional-section" :open="settings.r2_configured">
            <summary>
              <span><b>Cloudflare R2 镜像</b><small>可选；不影响本地处理和发布</small></span>
              <span class="setting-state" :class="settings.r2_configured ? 'is-ok' : ''">{{ settings.r2_configured ? '已配置' : '展开配置' }}</span>
            </summary>
            <div class="optional-section__body">
              <p class="section-help">配置后只追加一份异地镜像。R2 失败会记录警告，但不会删除或覆盖本地文件。</p>
              <div class="form-grid form-grid--2">
                <v-text-field v-model="r2AccountId" label="Cloudflare Account ID" autocomplete="off" hide-details />
                <v-text-field v-model="r2Bucket" label="Bucket 名称" autocomplete="off" hide-details />
                <v-text-field v-model="r2AccessKeyId" label="新的 Access Key ID" type="password" autocomplete="new-password" :placeholder="settings.r2_access_key_id_masked || ''" hide-details />
                <v-text-field v-model="r2SecretAccessKey" label="新的 Secret Access Key" type="password" autocomplete="new-password" :placeholder="settings.r2_secret_access_key_masked || ''" hide-details />
                <v-text-field v-model="r2PublicBaseUrl" class="is-wide" label="公开域名（可选）" placeholder="https://files.example.com" hide-details />
              </div>
              <div class="form-actions"><v-btn color="primary" :loading="loading" :disabled="!r2AccountId || !r2Bucket || r2AccessKeyId.length < 8 || r2SecretAccessKey.length < 8" @click="saveR2">验证存储桶并保存</v-btn></div>
            </div>
          </details>

          <section id="documents" class="settings-section document-settings">
            <header><div><h2>文档管理</h2><p>后台显示全部文档。新上传默认私有，只有管理员在这里公开后才进入公开文库。</p></div><span class="setting-state">{{ documents.length }} 份</span></header>
            <v-text-field v-model="documentQuery" prepend-inner-icon="mdi-magnify" placeholder="搜索文档" aria-label="搜索文档" hide-details clearable class="document-search" />
            <div v-if="filteredDocuments.length" class="admin-document-list">
              <div v-for="document in filteredDocuments" :key="document.id" class="admin-document-row">
                <div class="admin-document-row__copy"><strong>{{ document.title }}</strong><span>{{ document.display_filename }}</span><small><i :class="document.is_public ? 'is-public' : ''">{{ document.is_public ? '公开' : '私有' }}</i> · {{ document.id }}</small></div>
                <div class="admin-document-actions">
                  <v-btn :to="`/documents/${document.id}`" icon="mdi-eye-outline" size="small" variant="text" title="查看文档" />
                  <v-btn :href="`/api/v1/jobs/${document.id}/bundle`" icon="mdi-folder-zip-outline" size="small" variant="text" title="下载完整归档包" />
                  <v-btn icon="mdi-pencil-outline" size="small" variant="text" title="修改展示名称" @click="beginRename(document)" />
                  <v-btn :icon="document.is_public ? 'mdi-lock-outline' : 'mdi-earth'" size="small" :color="document.is_public ? undefined : 'primary'" variant="text" :title="document.is_public ? '设为私有' : '公开文档'" :loading="loading" @click="toggleVisibility(document)" />
                </div>
              </div>
            </div>
            <div v-else class="inline-empty">{{ documentQuery ? '没有匹配的文档' : '还没有可管理的文档' }}</div>
          </section>

          <div class="security-note"><v-icon icon="mdi-shield-lock-outline" size="18" /><p>API Key 仅以加密形式写入 PostgreSQL。请将 <code>data/config</code> 与数据库一起备份；更换实例密钥会导致已保存凭据无法解密。</p></div>
        </main>
      </div>
    </template>

    <v-dialog :model-value="Boolean(renameId)" max-width="580" @update:model-value="(value) => { if (!value) cancelRename() }">
      <v-card class="rename-dialog">
        <header><h2>重命名文档</h2><p>只更新数据库映射，不移动本地文件。</p></header>
        <v-text-field v-model="renameTitle" label="网页展示标题" maxlength="512" counter />
        <v-text-field v-model="renameFilename" label="源文件下载名称" hint="必须保留原扩展名；允许中文、空格和常用符号" persistent-hint maxlength="512" />
        <v-card-actions class="px-0 pb-0 mt-3"><v-spacer /><v-btn variant="text" @click="cancelRename">取消</v-btn><v-btn color="primary" :loading="loading" :disabled="!renameTitle.trim() || !renameFilename.trim()" @click="saveNames">保存</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
