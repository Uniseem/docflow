# ADR-0005：所有 HTTP 走 Electron `net.fetch`，代理交给 Chromium

- 状态：已采纳
- 日期：2026-09-21
- 相关：docs/plan/04-translation.md

## 背景

用户所在网络经常需要代理才能访问大模型服务商。3.x 用 reqwest 自己实现了「跟随系统 / 不使用 / 自定义（http、https、socks5）」三种模式，Windows 读注册表、macOS 读 SystemConfiguration，代码不少。Node 自带的 `fetch`（undici）不读系统代理，SOCKS 要额外依赖。

## 决定

- 主进程里所有对外请求（大模型 API、模型列表、更新检查）用 **`electron.net.fetch`**，它走 Chromium 网络栈：默认自动使用系统代理（含 PAC），支持 HTTP/HTTPS/SOCKS5 代理，证书验证与系统一致。
- 「网络」设置只保留三档，映射到 `session.defaultSession.setProxy()`：跟随系统 → `{ mode: 'system' }`；不使用代理 → `{ mode: 'direct' }`；自定义 → `{ proxyRules: url }`（`http://`、`https://`、`socks5://` 都由 Chromium 解析）。
- 请求超时用 `AbortSignal.timeout()`；流式响应不需要（翻译请求都是非流式）。
- 渲染进程不发任何网络请求（CSP `connect-src 'none'`）。

## 备选方案

- Node `fetch` + `undici.ProxyAgent` + 手写系统代理探测：要维护平台代码，SOCKS 还需要第三方库。放弃。
- axios/got：同样不解决系统代理问题。放弃。

## 后果

- 好处：代理代码几乎为零；行为与 Chrome 一致，用户容易理解。
- 代价：`net.fetch` 只能在主进程 / utility process 里用，worker_threads 里不能用——所以翻译请求留在主进程，worker 只做 CPU 工作；单元测试里 `net.fetch` 不可用，翻译模块通过注入 `fetch` 函数来测试。
