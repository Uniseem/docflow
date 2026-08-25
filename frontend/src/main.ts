import '@mdi/font/css/materialdesignicons.css'
import 'katex/dist/katex.min.css'
import 'vuetify/styles'
import './styles.css'

import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi'

import App from './App.vue'
import router from './router'

const vuetify = createVuetify({
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    defaultTheme: 'docflow',
    themes: {
      docflow: {
        dark: false,
        colors: {
          background: '#f7f8fa', surface: '#ffffff', primary: '#2457d6', secondary: '#344054',
          accent: '#eef3ff', error: '#c4322b', info: '#1769aa', success: '#16825d', warning: '#a15c00',
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: 'lg', elevation: 0 },
    VCard: { rounded: 'lg', elevation: 0 },
    VTextField: { variant: 'outlined', density: 'comfortable' },
  },
})

createApp(App).use(router).use(vuetify).mount('#app')
