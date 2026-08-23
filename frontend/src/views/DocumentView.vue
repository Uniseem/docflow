<script setup lang="ts">
import katex from 'katex'
import{computed,nextTick,onBeforeUnmount,onMounted,ref}from'vue'
import{useRoute}from'vue-router'
import{api}from'../api'
import ProcessingTimeline from'../components/ProcessingTimeline.vue'
import StageOverview from'../components/StageOverview.vue'
import StatusChip from'../components/StatusChip.vue'
import type{DocumentDetail,ProcessingEvent}from'../types'

const route=useRoute(),documentItem=ref<DocumentDetail|null>(null),events=ref<ProcessingEvent[]>([]),eventTotal=ref(0),error=ref(''),connection=ref<'connecting'|'live'|'retrying'|'closed'>('connecting')
let eventCursor=0,stopStream:(()=>void)|undefined,retryTimer:number|undefined,refreshTimer:number|undefined
const latestEvent=computed(()=>events.value.at(-1)||null)
const isLive=computed(()=>Boolean(documentItem.value&&!['completed','failed'].includes(documentItem.value.status)))
const formatDate=(value:string)=>new Intl.DateTimeFormat('zh-CN',{dateStyle:'long',timeStyle:'medium',hour12:false}).format(new Date(value))
const formatSize=(bytes:number)=>bytes<1048576?`${(bytes/1024).toFixed(0)} KB`:`${(bytes/1048576).toFixed(1)} MB`
function elapsedText(){if(!documentItem.value)return'';const end=documentItem.value.completed_at?new Date(documentItem.value.completed_at):new Date();const seconds=Math.max(0,Math.round((end.getTime()-new Date(documentItem.value.created_at).getTime())/1000));if(seconds<60)return`${seconds} 秒`;if(seconds<3600)return`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;return`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分`}
async function renderMath(){await nextTick();globalThis.document.querySelectorAll<HTMLElement>('.math-inline,.math-block').forEach((element)=>{if(element.dataset.rendered)return;try{katex.render(element.textContent||'',element,{displayMode:element.classList.contains('math-block'),throwOnError:false});element.dataset.rendered='true'}catch{/* 保留 TeX 源码 */}})}
async function loadEvents(){let more=true;while(more){const response=await api.getDocumentEvents(String(route.params.id),eventCursor);for(const event of response.items)appendEvent(event,false);eventTotal.value=response.total;more=response.has_more;if(!response.items.length)break}}
function appendEvent(event:ProcessingEvent,refresh=true){if(events.value.some((item)=>item.id===event.id))return;events.value.push(event);events.value.sort((a,b)=>a.id-b.id);eventCursor=Math.max(eventCursor,event.id);eventTotal.value=Math.max(eventTotal.value,events.value.length);if(documentItem.value){documentItem.value.stage=event.stage;documentItem.value.progress=event.progress;if(event.stage==='completed')documentItem.value.status='completed';else if(event.stage==='failed')documentItem.value.status='failed';else if(event.stage==='retrying')documentItem.value.status='retrying';else if(documentItem.value.status!=='failed')documentItem.value.status='processing'}if(refresh)scheduleRefresh()}
function scheduleRefresh(){window.clearTimeout(refreshTimer);refreshTimer=window.setTimeout(async()=>{try{documentItem.value=await api.getDocument(String(route.params.id));if(documentItem.value.status==='completed')await renderMath()}catch{/* SSE 仍会继续 */}},500)}
function connect(){stopStream?.();if(!isLive.value){connection.value='closed';return}connection.value='connecting';stopStream=api.streamDocumentEvents(String(route.params.id),eventCursor,(event)=>{connection.value='live';appendEvent(event)},async()=>{connection.value='closed';documentItem.value=await api.getDocument(String(route.params.id));await renderMath()},()=>{connection.value='retrying';retryTimer=window.setTimeout(async()=>{await loadEvents().catch(()=>undefined);scheduleRefresh();connect()},2000)})}
async function load(){try{documentItem.value=await api.getDocument(String(route.params.id));await loadEvents();if(documentItem.value.status==='completed')await renderMath();else connect()}catch(reason){error.value=reason instanceof Error?reason.message:'无法加载文档'}}
onMounted(load);onBeforeUnmount(()=>{stopStream?.();window.clearTimeout(retryTimer);window.clearTimeout(refreshTimer)})
</script>

<template>
  <v-container v-if="error" class="py-16"><v-alert type="error" variant="tonal">{{ error }}</v-alert></v-container>
  <template v-else-if="documentItem">
    <v-container v-if="documentItem.status==='completed'" class="reader-wrap pb-16">
      <header class="article-header">
        <div class="d-flex flex-wrap align-center ga-2 mb-5"><StatusChip :status="documentItem.status" /><v-chip size="small" variant="tonal" color="success" prepend-icon="mdi-harddisk">本地已归档</v-chip><v-chip v-if="documentItem.r2_mirror_status==='archived'" size="small" variant="tonal" color="info" prepend-icon="mdi-cloud-check-outline">R2 镜像完成</v-chip><v-chip v-if="documentItem.translated" size="small" variant="tonal" prepend-icon="mdi-translate">中文译文</v-chip><v-chip size="small" variant="tonal" prepend-icon="mdi-timer-outline">{{ elapsedText() }}</v-chip></div>
        <h1 class="article-title mb-5">{{ documentItem.title }}</h1>
        <div class="document-meta-value d-flex flex-wrap ga-4 mb-6"><span>{{ formatDate(documentItem.created_at) }}</span><span>{{ documentItem.display_filename }}</span><span>{{ formatSize(documentItem.source_size) }}</span><span>{{ documentItem.image_count }} 张 WebP</span></div>
        <div class="d-flex flex-wrap ga-2"><v-btn :href="`/api/v1/jobs/${documentItem.id}/bundle`" color="primary" prepend-icon="mdi-folder-zip-outline">打包全部文件</v-btn><v-btn :href="`/api/v1/jobs/${documentItem.id}/source`" variant="outlined" prepend-icon="mdi-download">原始文件</v-btn><v-btn v-if="documentItem.markdown_available?.normalized" :href="`/api/v1/jobs/${documentItem.id}/markdown?variant=normalized`" variant="outlined" prepend-icon="mdi-language-markdown">规范化 Markdown</v-btn><v-btn v-if="documentItem.markdown_available?.original" :href="`/api/v1/jobs/${documentItem.id}/markdown?variant=original`" variant="text">MinerU 原稿</v-btn></div>
      </header>
      <v-expansion-panels class="mb-6"><v-expansion-panel class="process-audit-panel"><v-expansion-panel-title><div><strong>处理与归档审计</strong><div class="text-caption muted">{{ eventTotal }} 条永久事件 · 最终进度 100%</div></div></v-expansion-panel-title><v-expansion-panel-text><StageOverview :document="documentItem" class="mb-6" /><ProcessingTimeline :events="events" :total="eventTotal" :created-at="documentItem.created_at" /></v-expansion-panel-text></v-expansion-panel></v-expansion-panels>
      <v-card class="article-paper"><v-card-text class="pa-7 pa-md-12"><article class="article-content" v-html="documentItem.content_html" /></v-card-text></v-card>
    </v-container>

    <v-container v-else class="processing-wrap py-8 py-md-12">
      <v-card class="processing-detail-card">
        <div class="processing-head"><v-progress-circular :model-value="documentItem.progress" :color="documentItem.status==='failed'?'error':'primary'" :size="112" :width="8"><div><span class="progress-number">{{ documentItem.progress }}</span><span class="progress-label">/ 100</span></div></v-progress-circular><div><div class="d-flex flex-wrap align-center ga-2 mb-3"><StatusChip :status="documentItem.status" /><v-chip size="small" variant="tonal" prepend-icon="mdi-harddisk">源文件已永久保存</v-chip><v-chip size="small" variant="tonal" prepend-icon="mdi-clock-outline">{{ elapsedText() }}</v-chip><v-chip size="small" variant="tonal" :color="connection==='live'?'success':'default'" prepend-icon="mdi-access-point">{{ connection==='live'?'SSE 实时连接':connection==='retrying'?'正在重连':'正在连接' }}</v-chip><v-chip size="small" variant="tonal">{{ eventTotal }} 条事件</v-chip></div><h1 class="processing-title font-weight-bold mb-2">{{ documentItem.title }}</h1><p class="muted text-body-2">{{ documentItem.display_filename }} · {{ formatSize(documentItem.source_size) }}</p></div></div>
        <v-progress-linear :model-value="documentItem.progress" :color="documentItem.status==='failed'?'error':'primary'" height="7" class="mt-7" />
        <div class="current-event-card" :class="{'is-error':documentItem.status==='failed'}"><div class="current-event-card__label">{{ documentItem.status==='failed'?'最终失败位置':'当前步骤' }}</div><h2>{{ latestEvent?.message||documentItem.stage }}</h2><p v-if="latestEvent?.detail">{{ latestEvent.detail }}</p><div class="current-event-card__meta"><span>阶段：{{ documentItem.stage }}</span><span v-if="latestEvent">事件 #{{ latestEvent.id }}</span><span v-if="latestEvent && latestEvent.current!==null">计数：{{ latestEvent.current }}<template v-if="latestEvent.total!==null"> / {{ latestEvent.total }}</template></span></div></div>
        <section class="mt-8"><div class="d-flex align-end justify-space-between mb-4"><div><div class="eyebrow mb-2">Pipeline</div><h2 class="section-title">八个处理阶段</h2></div><span class="text-caption muted">数据持续写入 PostgreSQL</span></div><StageOverview :document="documentItem" /></section>
        <v-alert v-if="documentItem.status==='failed'" type="error" variant="tonal" class="mt-6"><strong>最终错误</strong><div class="mt-1">{{ documentItem.failure_reason||'未知错误' }}</div></v-alert>
        <ProcessingTimeline class="mt-7" :events="events" :total="eventTotal" :created-at="documentItem.created_at" :live="isLive" />
        <div class="processing-footer-actions"><p class="text-caption muted">{{ isLive?'SSE 会实时推送每个细分步骤；离开页面不会中断任务。':'源文件和全部处理事件仍被保留。' }}</p><div class="d-flex flex-wrap ga-2"><v-btn :href="`/api/v1/jobs/${documentItem.id}/bundle`" variant="outlined" prepend-icon="mdi-folder-zip-outline">打包当前数据</v-btn><v-btn :href="`/api/v1/jobs/${documentItem.id}/source`" variant="outlined" prepend-icon="mdi-download">下载源文件</v-btn></div></div>
      </v-card>
    </v-container>
  </template>
  <v-container v-else class="py-16 text-center"><v-progress-circular indeterminate color="primary" /></v-container>
</template>
