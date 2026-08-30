import 'ant-design-vue/dist/reset.css'
import 'katex/dist/katex.min.css'
import './styles.css'

import { createApp } from 'vue'
import {
  Alert, Badge, Button, Card, ConfigProvider, Drawer, Empty, Form, Input, Layout,
  List, Menu, Progress, Radio, Space, Spin, Steps, Tag, Upload,
} from 'ant-design-vue'

import App from './App.vue'
import router from './router'

const app = createApp(App).use(router)
for (const component of [
  Alert, Badge, Button, Card, ConfigProvider, Drawer, Empty, Form, Input, Layout,
  List, Menu, Progress, Radio, Space, Spin, Steps, Tag, Upload,
]) app.use(component)
app.mount('#app')
