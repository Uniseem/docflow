<script setup lang="ts">
import { ref } from 'vue'

const drawer = ref(false)
const nav = [
  { label: '提交', to: '/', icon: 'mdi-plus' },
  { label: '文库', to: '/library', icon: 'mdi-text-box-multiple-outline' },
]
</script>

<template>
  <v-app>
    <v-app-bar class="app-bar" height="64" flat>
      <v-container class="d-flex align-center py-0">
        <router-link class="brand" to="/" aria-label="文流首页">
          <span class="brand-mark"><v-icon icon="mdi-file-document-check-outline" size="20" /></span>
          <span>
            <b>文流</b>
            <small>DOCFLOW</small>
          </span>
        </router-link>
        <v-spacer />
        <nav class="desktop-nav" aria-label="主导航">
          <v-btn v-for="item in nav" :key="item.to" :to="item.to" variant="text" :prepend-icon="item.icon">
            {{ item.label }}
          </v-btn>
        </nav>
        <v-btn class="desktop-nav ml-1" href="/api/docs" target="_blank" variant="text" prepend-icon="mdi-api">API</v-btn>
        <v-btn class="mobile-nav" icon="mdi-menu" variant="text" aria-label="打开导航" @click="drawer = true" />
      </v-container>
    </v-app-bar>

    <v-navigation-drawer v-model="drawer" location="right" temporary width="280">
      <div class="pa-5 text-subtitle-2">导航</div>
      <v-list nav>
        <v-list-item v-for="item in nav" :key="item.to" :to="item.to" :prepend-icon="item.icon" :title="item.label" @click="drawer = false" />
      </v-list>
      <v-list nav><v-list-item href="/api/docs" prepend-icon="mdi-api" title="开放 API" /></v-list>
    </v-navigation-drawer>

    <v-main>
      <router-view />
    </v-main>

    <footer class="site-footer">
      <v-container class="d-flex flex-wrap justify-space-between ga-4">
        <span>文流 · 自托管文档解析与翻译</span>
        <span>公开内容 · VPS 本地永久归档 · R2 可选镜像</span>
      </v-container>
    </footer>
  </v-app>
</template>
