import assert from 'node:assert/strict'
import test from 'node:test'
import { adminSettings, ApiError, button, fill, flush, mountView, publicConfig, selectFile } from './helpers/mount-view.mjs'

test('clicking Start processing on the real Ant Design form uploads and opens the created task', async (t) => {
  const calls = []
  const { host, routes } = await mountView(t, 'HomeView', {
    publicConfig: async () => publicConfig,
    listDocuments: async () => ({ items: [] }),
    uploadDocument: async (file, title, tier, mode) => { calls.push({ name: file.name, title, tier, mode }); return { id: 'new-task' } },
  })
  await selectFile(host, '论文.pdf')
  const submit = button(host, '开始处理')
  assert.equal(submit.disabled, false)
  submit.click()
  await flush()
  assert.deepEqual(calls, [{ name: '论文.pdf', title: '论文', tier: 2, mode: 'mineru' }])
  assert.deepEqual(routes, ['/documents/new-task'])
})

test('first administrator registers with only username and password through the real form', async (t) => {
  const calls = []
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: false }),
    adminRegister: async (...args) => { calls.push(args); return { token: 'fixture-token' } },
    ensureAdminSession: async () => {},
    adminSettings: async () => adminSettings,
    adminListDocuments: async () => ({ items: [], total: 0 }),
  })
  assert.match(host.textContent, /注册首位管理员/)
  await fill(host.querySelector('input[autocomplete="username"]'), 'fixture-admin')
  const passwords = host.querySelectorAll('input[type="password"]')
  assert.equal(passwords.length, 2)
  await fill(passwords[0], 'fixture-password-123')
  await fill(passwords[1], 'fixture-password-123')
  button(host, '注册并进入后台').click()
  await flush()
  assert.deepEqual(calls, [['fixture-admin', 'fixture-password-123']])
  assert.match(host.textContent, /默认翻译档位/)
})

test('existing administrator can log in by submitting the real Ant Design form', async (t) => {
  const calls = []
  let signedIn = false
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: true }),
    adminLogin: async (...args) => { calls.push(args); signedIn = true; return { token: 'fixture-token' } },
    ensureAdminSession: async () => { if (!signedIn) throw new ApiError('not logged in', 401) }, adminSettings: async () => adminSettings,
    adminListDocuments: async () => ({ items: [], total: 0 }),
  })
  await fill(host.querySelector('input[autocomplete="username"]'), 'fixture-admin')
  await fill(host.querySelector('input[type="password"]'), 'fixture-password-123')
  button(host, '登录').click()
  await flush()
  assert.deepEqual(calls, [['fixture-admin', 'fixture-password-123']])
  assert.match(host.textContent, /退出登录/)
})

test('native PDF click reaches the same upload API and selected translation pool', async (t) => {
  const calls = []
  const { host, routes } = await mountView(t, 'HomeView', {
    publicConfig: async () => ({ ...publicConfig, default_processing_mode: 'pdf2zh', translation_tier: 3 }),
    listDocuments: async () => ({ items: [] }),
    uploadDocument: async (...args) => { calls.push(args); return { id: 'native-task' } },
  })
  await selectFile(host)
  button(host, '开始处理').click()
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2], 3)
  assert.equal(calls[0][3], 'pdf2zh')
  assert.deepEqual(routes, ['/documents/native-task'])
})

test('in-flight upload displays progress, rejects duplicate clicks and surfaces failure without losing the file', async (t) => {
  let calls = 0
  let rejectUpload
  const { host, routes } = await mountView(t, 'HomeView', {
    publicConfig: async () => publicConfig,
    listDocuments: async () => ({ items: [] }),
    uploadDocument: async (_file, _title, _tier, _mode, progress) => {
      calls += 1
      progress(100)
      return new Promise((_resolve, reject) => { rejectUpload = reject })
    },
  })
  await selectFile(host, 'keep.pdf')
  const submit = button(host, '开始处理')
  submit.click()
  await flush()
  assert.match(host.textContent, /正在保存并创建任务/)
  button(host, '正在提交').click()
  await flush()
  assert.equal(calls, 1)
  rejectUpload(new Error('服务繁忙，请重试'))
  await flush()
  assert.match(host.textContent, /服务繁忙，请重试/)
  assert.match(host.textContent, /keep.pdf/)
  assert.equal(button(host, '开始处理').disabled, false)
  assert.deepEqual(routes, [])
})

test('a cookie-only administrator session opens the dashboard without localStorage credentials', async (t) => {
  assert.equal(localStorage.getItem('docflow-admin-token'), null)
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: true }),
    ensureAdminSession: async () => {}, adminSettings: async () => adminSettings,
    adminListDocuments: async () => ({ items: [], total: 0 }),
  })
  assert.match(host.textContent, /默认翻译档位/)
  assert.doesNotMatch(host.textContent, /管理员登录|注册并进入后台/)
})

test('browser storage exceptions do not prevent first registration or dashboard access', async (t) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage disabled') } })
  try {
    const { host } = await mountView(t, 'AdminView', {
      adminStatus: async () => ({ initialized: false }),
      adminRegister: async () => ({ token: 'memory-only-fixture' }),
      ensureAdminSession: async () => {}, adminSettings: async () => adminSettings,
      adminListDocuments: async () => ({ items: [], total: 0 }),
    })
    await fill(host.querySelector('input[autocomplete="username"]'), 'fixture-admin')
    for (const input of host.querySelectorAll('input[type="password"]')) await fill(input, 'fixture-password-123')
    button(host, '注册并进入后台').click()
    await flush()
    assert.match(host.textContent, /默认翻译档位/)
  } finally { Object.defineProperty(globalThis, 'localStorage', storage) }
})

test('an unavailable admin API shows a retry action and can recover to first registration', async (t) => {
  let attempts = 0
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => { if (++attempts === 1) throw new ApiError('管理服务暂时不可用', 503); return { initialized: false } },
  })
  assert.match(host.textContent, /管理服务暂时不可用/)
  button(host, '重新连接后台').click()
  await flush()
  assert.match(host.textContent, /无需初始化密钥/)
  assert.match(host.textContent, /注册首位管理员/)
})

test('a temporary session restore failure preserves the saved login and provides reconnect', async (t) => {
  localStorage.setItem('docflow-admin-token', 'existing-fixture-token')
  let attempts = 0
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: true }),
    ensureAdminSession: async () => { if (++attempts === 1) throw new ApiError('管理服务暂时不可用', 503) },
    adminSettings: async () => adminSettings, adminListDocuments: async () => ({ items: [], total: 0 }),
  })
  assert.equal(localStorage.getItem('docflow-admin-token'), 'existing-fixture-token')
  button(host, '重新连接后台').click()
  await flush()
  assert.match(host.textContent, /默认翻译档位/)
})

test('an expired token is cleared and returns the existing administrator to login, never registration', async (t) => {
  localStorage.setItem('docflow-admin-token', 'expired-fixture-token')
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: true }),
    ensureAdminSession: async () => { throw new ApiError('expired', 401) },
  })
  assert.equal(localStorage.getItem('docflow-admin-token'), null)
  assert.match(host.textContent, /管理员登录已过期/)
  assert.match(host.textContent, /管理员登录/)
  assert.doesNotMatch(host.textContent, /注册首位管理员/)
})

test('registration lost to another visitor switches to login without overwriting the administrator', async (t) => {
  let initialized = false
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized }),
    adminRegister: async () => { initialized = true; throw new ApiError('管理员已经注册，请直接登录', 409) },
  })
  await fill(host.querySelector('input[autocomplete="username"]'), 'fixture-admin')
  for (const input of host.querySelectorAll('input[type="password"]')) await fill(input, 'fixture-password-123')
  button(host, '注册并进入后台').click()
  await flush()
  assert.match(host.textContent, /管理员已经注册，请直接登录/)
  assert.match(host.textContent, /管理员登录/)
  assert.equal(host.querySelectorAll('input[type="password"]').length, 1)
})

test('mismatched confirmation does not register and leaves a visible explanation', async (t) => {
  let calls = 0
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: false }), adminRegister: async () => { calls += 1 },
  })
  await fill(host.querySelector('input[autocomplete="username"]'), 'fixture-admin')
  const passwords = host.querySelectorAll('input[type="password"]')
  await fill(passwords[0], 'fixture-password-123')
  await fill(passwords[1], 'different-password')
  button(host, '注册并进入后台').click()
  await flush()
  assert.equal(calls, 0)
  assert.match(host.textContent, /两次输入的密码不一致/)
})

test('Enter logs in once, ignores IME composition and cannot bypass required credentials', async (t) => {
  let calls = 0
  let signedIn = false
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: true }),
    ensureAdminSession: async () => { if (!signedIn) throw new ApiError('not logged in', 401) },
    adminLogin: async () => { calls += 1; signedIn = true; return { token: 'fixture-token' } },
    adminSettings: async () => adminSettings, adminListDocuments: async () => ({ items: [], total: 0 }),
  })
  const password = host.querySelector('input[type="password"]')
  password.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flush()
  assert.equal(calls, 0)
  assert.match(host.textContent, /请填写管理员名称/)
  await fill(host.querySelector('input[autocomplete="username"]'), 'fixture-admin')
  await fill(password, 'fixture-password-123')
  password.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
  await flush()
  assert.equal(calls, 0)
  password.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  button(host, '登录').click()
  await flush()
  assert.equal(calls, 1)
  assert.match(host.textContent, /默认翻译档位/)
})

test('all administrator save forms execute their handlers via real submit buttons', async (t) => {
  const calls = []
  const { host } = await mountView(t, 'AdminView', {
    adminStatus: async () => ({ initialized: true }), ensureAdminSession: async () => {},
    adminSettings: async () => structuredClone(adminSettings), adminListDocuments: async () => ({ items: [], total: 0 }),
    saveTranslationRuntime: async (value) => { calls.push(['runtime', value]); return { ...adminSettings, translation_runtime: value } },
    saveMinerU: async (...args) => { calls.push(['mineru', ...args]); return adminSettings },
    saveGoogle: async (...args) => { calls.push(['google', ...args]); return adminSettings },
    saveDeepSeek: async (...args) => { calls.push(['deepseek', ...args]); return adminSettings },
    saveR2: async (...args) => { calls.push(['r2', ...args]); return adminSettings },
  })
  await fill(host.querySelector('textarea'), '测试用全局翻译提示词。')
  button(host, '保存翻译配置').click()
  await flush()
  assert.equal(calls[0][0], 'runtime')
  assert.equal(calls[0][1].system_prompt, '测试用全局翻译提示词。')
  host.querySelector('[role="tab"][id$="credentials"]').click()
  await flush()
  const forms = [...host.querySelectorAll('form')].filter((form) => form.querySelector('input[type="password"]'))
  assert.equal(forms.length, 3)
  for (const [index, form] of forms.entries()) {
    await fill(form.querySelector('input[type="password"]'), `fake-provider-key-${index}`)
    button(form, '验证并保存').click()
    await flush()
  }
  assert.deepEqual(calls.slice(1).map((call) => call[0]), ['mineru', 'google', 'deepseek'])
  host.querySelector('[role="tab"][id$="storage"]').click()
  await flush()
  const r2Form = [...host.querySelectorAll('form')].find((form) => form.querySelectorAll('input[type="password"]').length === 2)
  assert.ok(r2Form)
  for (const [index, input] of [...r2Form.querySelectorAll('input')].entries()) await fill(input, `fake-r2-value-${index}`)
  button(r2Form, '验证并保存').click()
  await flush()
  assert.equal(calls.at(-1)[0], 'r2')
})
