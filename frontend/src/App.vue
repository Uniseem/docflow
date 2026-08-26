<script setup lang="ts">
import { ref } from 'vue'

const drawer = ref(false)
const nav = [
  { label: '提交文档', to: '/', icon: 'mdi-tray-arrow-up' },
  { label: '公开文库', to: '/library', icon: 'mdi-bookshelf' },
]
</script>

<template>
  <v-app>
    <header class="topbar">
      <div class="topbar__inner">
        <router-link class="brand" to="/" aria-label="文流首页">
          <span class="brand-mark">文</span>
          <span class="brand-copy"><strong>文流</strong><small>DOCFLOW</small></span>
        </router-link>
        <nav class="desktop-nav" aria-label="主导航">
          <router-link v-for="item in nav" :key="item.to" :to="item.to">{{ item.label }}</router-link>
          <a href="/api/docs" target="_blank">开放 API <v-icon icon="mdi-arrow-top-right" size="15" /></a>
        </nav>
        <button class="mobile-menu" type="button" aria-label="打开导航" @click="drawer = true"><v-icon icon="mdi-menu" size="24" /></button>
      </div>
    </header>

    <v-navigation-drawer v-model="drawer" class="mobile-drawer" location="right" temporary width="300">
      <div class="drawer-head"><span class="brand-mark">文</span><span class="brand-copy"><strong>文流</strong><small>DOCFLOW</small></span></div>
      <v-list nav density="comfortable">
        <v-list-item v-for="item in nav" :key="item.to" :to="item.to" :prepend-icon="item.icon" :title="item.label" @click="drawer = false" />
        <v-list-item href="/api/docs" target="_blank" prepend-icon="mdi-api" title="开放 API" />
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <router-view />
    </v-main>

    <footer class="site-footer">
      <div class="footer-inner"><strong>文流 DocFlow</strong><span>默认私有 · 本地永久保存 · 支持完整迁移</span></div>
    </footer>
  </v-app>
</template>
