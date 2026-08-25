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
    <v-app-bar class="app-bar" height="62" flat>
      <v-container class="app-bar__inner">
        <router-link class="brand" to="/" aria-label="文流首页">
          <span class="brand-mark">文</span>
          <span class="brand-name">文流</span>
        </router-link>
        <v-spacer />
        <nav class="desktop-nav" aria-label="主导航">
          <v-btn v-for="item in nav" :key="item.to" :to="item.to" variant="text">
            {{ item.label }}
          </v-btn>
        </nav>
        <span class="nav-separator desktop-nav" />
        <v-btn class="desktop-nav" href="/api/docs" target="_blank" variant="text" append-icon="mdi-open-in-new" size="small">API</v-btn>
        <v-btn class="mobile-nav" icon="mdi-menu" variant="text" aria-label="打开导航" @click="drawer = true" />
      </v-container>
    </v-app-bar>

    <v-navigation-drawer v-model="drawer" location="right" temporary width="280">
      <div class="drawer-head"><span class="brand-mark">文</span><strong>文流</strong></div>
      <v-list nav>
        <v-list-item v-for="item in nav" :key="item.to" :to="item.to" :prepend-icon="item.icon" :title="item.label" @click="drawer = false" />
      </v-list>
      <v-list nav><v-list-item href="/api/docs" target="_blank" prepend-icon="mdi-api" title="开放 API" /></v-list>
    </v-navigation-drawer>

    <v-main>
      <router-view />
    </v-main>

    <footer class="site-footer">
      <v-container class="footer-inner">
        <span>文流 DocFlow</span>
        <span>默认私有 · 管理员可公开 · 本地永久保存</span>
      </v-container>
    </footer>
  </v-app>
</template>
