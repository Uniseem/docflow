import { createRouter, createWebHistory } from 'vue-router'

import HomeView from './views/HomeView.vue'

const AdminView = () => import('./views/AdminView.vue')
const DocumentView = () => import('./views/DocumentView.vue')
const LibraryView = () => import('./views/LibraryView.vue')

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
