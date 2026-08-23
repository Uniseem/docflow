import { createRouter, createWebHistory } from 'vue-router'

import AdminView from './views/AdminView.vue'
import DocumentView from './views/DocumentView.vue'
import HomeView from './views/HomeView.vue'
import LibraryView from './views/LibraryView.vue'

export default createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/library', name: 'library', component: LibraryView },
    { path: '/documents/:id', name: 'document', component: DocumentView },
    { path: '/admin', name: 'admin', component: AdminView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

