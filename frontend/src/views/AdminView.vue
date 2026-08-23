<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { api } from '../api'
import type { AdminSettings, DocumentSummary } from '../types'

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
const r2AccountId = ref('')
const r2AccessKeyId = ref('')
const r2SecretAccessKey = ref('')
const r2Bucket = ref('')
const r2PublicBaseUrl = ref('')
const documents = ref<DocumentSummary[]>([])
const renameId = ref('')
const renameTitle = ref('')
const renameFilename = ref('')
const loading = ref(false)
const message = ref('')
const error = ref('')

async function loadSettings() {
  if (!token.value) return
  try {
    settings.value = await api.adminSettings()
    mineruModel.value = settings.value.mineru_model
    deepseekModel.value = settings.value.deepseek_model
    r2AccountId.value = settings.value.r2_account_id
    r2Bucket.value = settings.value.r2_bucket
    r2PublicBaseUrl.value = settings.value.r2_public_base_url
    documents.value = (await api.listDocuments(1, 100)).items
  } catch {
    logout()
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

function logout() {
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
    message.value = 'DeepSeek 模型调用成功；网站现在默认勾选中文翻译。'
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
    message.value = 'R2 存储桶访问验证成功。新任务会在本地永久归档后附加一份 R2 镜像。'
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
    message.value = '展示标题和下载文件名已更新；服务器物理目录与文件名没有变化。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '重命名失败'
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
  <v-container class="py-12 py-md-16" style="max-width: 920px !important">
    <div class="eyebrow mb-3">Administration</div>
    <h1 class="page-title mb-3">管理后台</h1>
    <p class="muted mb-9">配置解析、翻译与可选 R2 镜像；管理数据库中的公开展示名。所有凭据使用实例密钥加密后写入 PostgreSQL。</p>

    <div v-if="initialized === null" class="py-12"><v-progress-circular indeterminate color="primary" /></div>

    <v-card v-else-if="!token" class="admin-card pa-6 pa-md-8" style="max-width: 520px">
      <h2 class="text-h5 font-weight-bold mb-2">{{ initialized ? '管理员登录' : '注册首位管理员' }}</h2>
      <p class="muted text-body-2 mb-6">
        {{ initialized ? '输入管理员名称和密码继续。' : '该实例尚未初始化。第一个完成注册的人将成为唯一管理员。' }}
      </p>
      <v-alert v-if="!initialized" type="warning" variant="tonal" class="mb-5">注册完成后将永久关闭初始化入口，请妥善保存凭据。</v-alert>
      <v-text-field v-model="username" label="管理员名称" autocomplete="username" prepend-inner-icon="mdi-account-outline" />
      <v-text-field
        v-model="password"
        label="管理员密码"
        type="password"
        :autocomplete="initialized ? 'current-password' : 'new-password'"
        prepend-inner-icon="mdi-lock-outline"
        @keyup.enter="initialized ? login() : register()"
      />
      <v-text-field
        v-if="!initialized"
        v-model="passwordConfirm"
        label="再次输入密码"
        type="password"
        autocomplete="new-password"
        prepend-inner-icon="mdi-lock-check-outline"
        hint="至少 10 个字符"
        persistent-hint
        @keyup.enter="register"
      />
      <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
      <v-btn
        color="primary"
        block
        size="large"
        :loading="loading"
        :disabled="username.trim().length < 2 || !password || (!initialized && password.length < 10)"
        @click="initialized ? login() : register()"
      >
        {{ initialized ? '登录' : '注册并进入后台' }}
      </v-btn>
    </v-card>

    <template v-else-if="settings">
      <div class="d-flex justify-end mb-4"><v-btn variant="text" prepend-icon="mdi-logout" @click="logout">退出登录</v-btn></div>
      <v-alert v-if="message" type="success" variant="tonal" closable class="mb-5" @click:close="message = ''">{{ message }}</v-alert>
      <v-alert v-if="error" type="error" variant="tonal" closable class="mb-5" @click:close="error = ''">{{ error }}</v-alert>

      <v-row>
        <v-col cols="12" md="6">
          <v-card class="admin-card pa-6 h-100">
            <div class="d-flex align-center justify-space-between mb-5">
              <div><div class="text-overline text-secondary">解析引擎</div><h2 class="text-h5 font-weight-bold">MinerU</h2></div>
              <v-chip :color="settings.mineru_configured ? 'success' : 'warning'" variant="tonal" size="small">{{ settings.mineru_configured ? '已配置' : '未配置' }}</v-chip>
            </div>
            <p v-if="settings.mineru_api_key_masked" class="text-caption muted mb-3">当前 Key：{{ settings.mineru_api_key_masked }}</p>
            <v-text-field v-model="mineruKey" label="新的 MinerU API Key" type="password" autocomplete="new-password" />
            <v-select v-model="mineruModel" label="解析模型" :items="[{ title: 'VLM（推荐）', value: 'vlm' }, { title: 'Pipeline', value: 'pipeline' }]" />
            <v-btn color="secondary" block :loading="loading" :disabled="mineruKey.length < 8" @click="saveMinerU">验证并保存</v-btn>
          </v-card>
        </v-col>

        <v-col cols="12" md="6">
          <v-card class="admin-card pa-6 h-100">
            <div class="d-flex align-center justify-space-between mb-5">
              <div><div class="text-overline text-secondary">中文翻译</div><h2 class="text-h5 font-weight-bold">DeepSeek</h2></div>
              <v-chip :color="settings.deepseek_configured ? 'success' : 'default'" variant="tonal" size="small">{{ settings.deepseek_configured ? '已启用' : '可选' }}</v-chip>
            </div>
            <p v-if="settings.deepseek_api_key_masked" class="text-caption muted mb-3">当前 Key：{{ settings.deepseek_api_key_masked }}</p>
            <v-text-field v-model="deepseekKey" label="新的 DeepSeek API Key" type="password" autocomplete="new-password" />
            <v-text-field v-model="deepseekModel" label="模型名称" hint="例如 deepseek-v4-flash" persistent-hint />
            <v-btn color="primary" block class="mt-4" :loading="loading" :disabled="deepseekKey.length < 8 || !deepseekModel" @click="saveDeepSeek">调用模型验证并保存</v-btn>
          </v-card>
        </v-col>
        <v-col cols="12">
          <v-card class="admin-card">
            <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-4">
              <div><div class="text-overline text-secondary">默认主存储</div><h2 class="text-h5 font-weight-bold">VPS 本地永久归档</h2></div>
              <v-chip color="success" variant="tonal" size="small">始终启用</v-chip>
            </div>
            <v-alert type="success" variant="tonal" density="compact">源文件上传完成即写入 <code>/data/archives</code> 的 UUID 目录；任务完成后补齐 Markdown、HTML、WebP、MinerU ZIP 和事件清单。用户展示名由 PostgreSQL 映射，绝不用于磁盘路径。</v-alert>
          </v-card>
        </v-col>
        <v-col cols="12">
          <v-card class="admin-card h-100">
            <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-5">
              <div><div class="text-overline text-secondary">永久对象存储</div><h2 class="text-h5 font-weight-bold">Cloudflare R2</h2></div>
              <v-chip :color="settings.r2_configured ? 'success' : 'default'" variant="tonal" size="small">{{ settings.r2_configured ? '已验证' : '可选' }}</v-chip>
            </div>
            <v-alert type="info" variant="tonal" density="compact" class="mb-5">留空即可只用 VPS 本地存储。配置后，任务会在本地归档完成后逐对象镜像并校验；R2 失败只记录警告，不影响本地文章发布，也不会删除本地文件。</v-alert>
            <v-row>
              <v-col cols="12" md="6"><v-text-field v-model="r2AccountId" label="Cloudflare Account ID" autocomplete="off" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model="r2Bucket" label="Bucket 名称" autocomplete="off" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model="r2AccessKeyId" label="新的 Access Key ID" type="password" autocomplete="new-password" :placeholder="settings.r2_access_key_id_masked || ''" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model="r2SecretAccessKey" label="新的 Secret Access Key" type="password" autocomplete="new-password" :placeholder="settings.r2_secret_access_key_masked || ''" /></v-col>
              <v-col cols="12"><v-text-field v-model="r2PublicBaseUrl" label="公开域名（可选）" hint="例如 https://files.example.com；留空时图片和下载由本站 API 安全代理" persistent-hint /></v-col>
            </v-row>
            <div class="d-flex justify-end mt-4"><v-btn color="primary" :loading="loading" :disabled="!r2AccountId || !r2Bucket || r2AccessKeyId.length < 8 || r2SecretAccessKey.length < 8" @click="saveR2">验证存储桶并保存</v-btn></div>
          </v-card>
        </v-col>
        <v-col cols="12">
          <v-card class="admin-card">
            <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-4">
              <div><div class="text-overline text-secondary">数据库名称映射</div><h2 class="text-h5 font-weight-bold">文档重命名</h2></div>
              <v-chip variant="tonal" size="small">{{ documents.length }} 份</v-chip>
            </div>
            <p class="text-body-2 muted mb-5">可分别修改网页标题和下载文件名。这里只更新 PostgreSQL；UUID 目录、ASCII 物理文件名、图片链接及历史事件全部保持不变。</p>
            <div v-if="documents.length" class="admin-document-list">
              <div v-for="document in documents" :key="document.id" class="admin-document-row">
                <div class="admin-document-row__copy">
                  <strong>{{ document.title }}</strong>
                  <span>{{ document.display_filename }}</span>
                  <small>{{ document.id }} · {{ document.local_archive_status }}</small>
                </div>
                <div class="d-flex ga-2">
                  <v-btn :href="`/api/v1/jobs/${document.id}/bundle`" icon="mdi-folder-zip-outline" size="small" variant="text" title="下载完整归档包" />
                  <v-btn icon="mdi-pencil-outline" size="small" variant="tonal" title="修改展示名称" @click="beginRename(document)" />
                </div>
              </div>
            </div>
            <v-alert v-else type="info" variant="tonal">还没有可管理的文档。</v-alert>
          </v-card>
        </v-col>
      </v-row>

      <v-dialog :model-value="Boolean(renameId)" max-width="620" @update:model-value="(value) => { if (!value) cancelRename() }">
        <v-card class="pa-6">
          <div class="text-overline text-secondary">只修改数据库映射</div>
          <h2 class="text-h5 font-weight-bold mb-5">重命名文档</h2>
          <v-text-field v-model="renameTitle" label="网页公开标题" maxlength="512" counter />
          <v-text-field v-model="renameFilename" label="源文件下载名称" hint="必须保留原扩展名；允许中文、空格和常用符号" persistent-hint maxlength="512" />
          <v-alert type="info" variant="tonal" density="compact" class="mt-2">保存后不会移动或改写任何本地文件。ZIP 包的 HTTP 下载名会使用新标题，包内物理路径仍为 ASCII。</v-alert>
          <v-card-actions class="px-0 pb-0 mt-4">
            <v-spacer />
            <v-btn variant="text" @click="cancelRename">取消</v-btn>
            <v-btn color="primary" :loading="loading" :disabled="!renameTitle.trim() || !renameFilename.trim()" @click="saveNames">保存名称</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-alert icon="mdi-shield-lock-outline" color="secondary" variant="tonal" class="mt-6">
        配置成功后只显示 Key 尾号。更换 <code>SECRET_KEY</code> 会导致 MinerU、DeepSeek 与 R2 凭据无法解密，请与 PostgreSQL 一起备份。
      </v-alert>
    </template>
  </v-container>
</template>
