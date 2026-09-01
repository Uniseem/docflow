<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { BookOutlined, ExportOutlined, FileTextOutlined, MenuOutlined, UploadOutlined } from '@ant-design/icons-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'

const route = useRoute()
const drawer = ref(false)
const selectedKeys = computed(() => route.path === '/' ? ['/'] : route.path.startsWith('/library') ? ['/library'] : [])
</script>

<template>
  <a-config-provider :locale="zhCN">
    <a-layout class="app-shell">
      <a-layout-header class="app-header">
        <div class="header-inner">
          <router-link class="brand" to="/" aria-label="文流首页"><FileTextOutlined /><strong>文流</strong><span>DocFlow</span></router-link>
          <a-menu class="desktop-navigation" mode="horizontal" :selected-keys="selectedKeys">
            <a-menu-item key="/"><template #icon><UploadOutlined /></template><router-link to="/">提交文档</router-link></a-menu-item>
            <a-menu-item key="/library"><template #icon><BookOutlined /></template><router-link to="/library">公开文库</router-link></a-menu-item>
            <a-menu-item key="api"><a href="/api/docs" target="_blank" rel="noopener noreferrer">开放 API <ExportOutlined /></a></a-menu-item>
          </a-menu>
          <a-button class="mobile-navigation" aria-label="打开导航" @click="drawer = true"><template #icon><MenuOutlined /></template></a-button>
        </div>
      </a-layout-header>
      <a-drawer v-model:open="drawer" title="文流 DocFlow" placement="right" :width="280">
        <a-menu mode="inline" :selected-keys="selectedKeys" @click="drawer = false">
          <a-menu-item key="/"><template #icon><UploadOutlined /></template><router-link to="/">提交文档</router-link></a-menu-item>
          <a-menu-item key="/library"><template #icon><BookOutlined /></template><router-link to="/library">公开文库</router-link></a-menu-item>
          <a-menu-item key="api"><template #icon><ExportOutlined /></template><a href="/api/docs" target="_blank" rel="noopener noreferrer">开放 API</a></a-menu-item>
        </a-menu>
      </a-drawer>
      <a-layout-content class="app-content">
        <div class="route-stage">
          <router-view v-slot="{ Component, route: viewRoute }">
            <transition name="route-view">
              <component :is="Component" :key="viewRoute.path" />
            </transition>
          </router-view>
        </div>
      </a-layout-content>
      <a-layout-footer class="app-footer">文流 DocFlow · 默认私有 · 本地永久保存 · <a href="https://github.com/FengYuchen1314/docflow/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">源码与许可</a></a-layout-footer>
    </a-layout>
  </a-config-provider>
</template>
