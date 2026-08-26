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
          background: '#f5f6f8', surface: '#ffffff', primary: '#315ee8', secondary: '#24272f',
          accent: '#edf1ff', error: '#c43d37', info: '#2366b1', success: '#16805c', warning: '#a16207',
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: 'lg', elevation: 0, height: 44 },
    VCard: { rounded: 'xl', elevation: 0 },
    VTextField: { variant: 'outlined', density: 'comfortable' },
  },
})

createApp(App).use(router).use(vuetify).mount('#app')
