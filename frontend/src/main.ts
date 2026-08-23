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
          background: '#f5f7f6', surface: '#ffffff', primary: '#176b4d', secondary: '#34433d',
          accent: '#dff0e8', error: '#b42318', info: '#246b8a', success: '#18794e', warning: '#946200',
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: 'md', elevation: 0 },
    VCard: { rounded: 'lg', elevation: 0 },
    VTextField: { variant: 'outlined', density: 'comfortable' },
  },
})

createApp(App).use(router).use(vuetify).mount('#app')
