# 04 翻译子系统

> 这是 3.x Rust 实现（`engine/src/providers.rs`、`pipeline/translate.rs`、`pipeline/translate_native.rs`、`translation_pool.rs`、`secrets.rs`）的 TypeScript 移植，除本章注明的改动外行为与参数一致。模块位于 `src/main/translate/`，全部是可在 vitest 里直接测的纯 Node 代码：`http.ts` 不引用 Electron，生产用的 `net.fetch` 由 `app/session.ts` 注入。提示词与常量在 `src/shared/constants.ts`，URL 拼接在 `src/shared/provider-url.ts`（设置页也用它显示「请求地址」）。

## 4.1 类型

`src/shared/types.ts`：

```ts
// z.url() 自己检查协议且不会抛错：在 .url() 后面接 .refine((u) => new URL(u)…)，zod 4 对
// 无效输入仍会执行 refine，new URL() 抛出的 TypeError 会从 parse() 里漏出来（M5 复查第 22 条）。
export const HttpUrl = z.url({ protocol: /^https?$/ }) // 必须写 `://`，`127.0.0.1:7890` 不通过

export const ProviderType = z.enum(['openai', 'azure', 'anthropic', 'gemini'])
// 标签：openai → 'OpenAI 兼容'，azure → 'Azure OpenAI'，anthropic → 'Anthropic'，gemini → 'Gemini'

export const ModelConfig = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\r\n]+$/),
  name: z.string().max(200).optional(),
})

export const ProviderConfig = z
  .object({
    id: z.string().regex(/^[a-z0-9-_]{1,64}$/),
    name: z.string().min(1).max(64),
    type: ProviderType,
    baseUrl: HttpUrl,
    enabled: z.boolean().default(true),
    models: z.array(ModelConfig).max(MAX_MODELS_PER_PROVIDER), // 500，id 唯一
    concurrency: z.number().int().min(1).max(2000).default(100),
    preset: z.string().optional(), // 来源预设 id
    extraBody: z.record(z.string(), z.unknown()).optional(), // 不得含 model/messages/stream/contents/system/systemInstruction
  })
  .strict()

export const TranslatorChoice = z.object({ providerId: z.string(), model: z.string() })
export const translatorLabel = (p: ProviderConfig, modelId: string) =>
  `${p.name} · ${p.models.find((m) => m.id === modelId)?.name ?? modelId}`

export const LlmRuntime = z.object({
  chunkChars: z.number().int().min(100).max(32_000).default(4000),
  maxSegmentsPerRequest: z.number().int().min(1).max(64).default(8),
  maxRequestChars: z.number().int().min(500).max(100_000).default(8000),
  maxOutputTokens: z.number().int().min(0).max(1_000_000).default(0), // 0 = 服务商默认
})
export const TranslationRuntime = z.object({
  llm: LlmRuntime,
  perDocumentConcurrency: z.number().int().min(1).max(1000).default(100),
  systemPrompt: z.string().max(12_000),
})
```

`models` id 唯一与 `extraBody` 禁用键由 `.strict()` 之后的 `.superRefine()` 检查（报错 `models id 必须唯一`、`extraBody 不得包含 <键>`）；禁用键列表是 `constants.ts` 的 `EXTRA_BODY_FORBIDDEN`。

## 4.2 预设（`src/shared/presets.ts`）

| id          | 名称                  | type      | baseUrl                                             | keyUrl                                            | keyOptional |
| ----------- | --------------------- | --------- | --------------------------------------------------- | ------------------------------------------------- | ----------- |
| deepseek    | DeepSeek              | openai    | `https://api.deepseek.com`                          | https://platform.deepseek.com/api_keys            |             |
| openai      | OpenAI                | openai    | `https://api.openai.com/v1`                         | https://platform.openai.com/api-keys              |             |
| anthropic   | Anthropic（Claude）   | anthropic | `https://api.anthropic.com`                         | https://console.anthropic.com/settings/keys       |             |
| gemini      | Google Gemini         | gemini    | `https://generativelanguage.googleapis.com`         | https://aistudio.google.com/apikey                |             |
| openrouter  | OpenRouter            | openai    | `https://openrouter.ai/api/v1`                      | https://openrouter.ai/keys                        |             |
| siliconflow | 硅基流动              | openai    | `https://api.siliconflow.cn/v1`                     | https://cloud.siliconflow.cn/account/ak           |             |
| dashscope   | 阿里云百炼            | openai    | `https://dashscope.aliyuncs.com/compatible-mode/v1` | https://bailian.console.aliyun.com/?apiKey=1      |             |
| volcengine  | 火山引擎（豆包）      | openai    | `https://ark.cn-beijing.volces.com/api/v3`          | https://console.volcengine.com/ark                |             |
| moonshot    | 月之暗面（Kimi）      | openai    | `https://api.moonshot.cn/v1`                        | https://platform.moonshot.cn/console/api-keys     |             |
| zhipu       | 智谱 AI               | openai    | `https://open.bigmodel.cn/api/paas/v4`              | https://open.bigmodel.cn/usercenter/apikeys       |             |
| hunyuan     | 腾讯混元              | openai    | `https://api.hunyuan.cloud.tencent.com/v1`          | https://console.cloud.tencent.com/hunyuan/api-key |             |
| stepfun     | 阶跃星辰              | openai    | `https://api.stepfun.com/v1`                        | https://platform.stepfun.com/interface-key        |             |
| minimax     | MiniMax               | openai    | `https://api.minimaxi.com/v1`                       | https://platform.minimaxi.com                     |             |
| xai         | xAI（Grok）           | openai    | `https://api.x.ai/v1`                               | https://console.x.ai                              |             |
| groq        | Groq                  | openai    | `https://api.groq.com/openai/v1`                    | https://console.groq.com/keys                     |             |
| mistral     | Mistral AI            | openai    | `https://api.mistral.ai/v1`                         | https://console.mistral.ai/api-keys               |             |
| azure       | Azure OpenAI          | azure     | `https://example.openai.azure.com/openai/v1`        | https://portal.azure.com                          |             |
| ollama      | Ollama（本机）        | openai    | `http://localhost:11434/v1`                         | —                                                 | ✓           |
| lmstudio    | LM Studio（本机）     | openai    | `http://localhost:1234/v1`                          | —                                                 | ✓           |
| custom      | 自定义（OpenAI 兼容） | openai    | （空）                                              | —                                                 |             |

界面分组：国内服务 = deepseek, siliconflow, dashscope, volcengine, moonshot, zhipu, hunyuan, stepfun, minimax；国际服务 = openai, anthropic, gemini, openrouter, xai, groq, mistral, azure；本机模型 = ollama, lmstudio；最后「自定义服务商…」。

azure 预设的 `example` 是占位的资源名，添加后要改成自己的资源地址。custom 预设的 baseUrl 为空，设置页添加时先填 `http://127.0.0.1:11434/v1`，由用户改写。

`keyOptional(provider)` = 预设标记为可选，或 host ∈ {localhost, 127.0.0.1, ::1, [::1]}（`LOCALHOSTS`）。设置视图与 `llmReady` 用它判断「无需 Key」；并发池对 `keyOptional` 且没有保存 Key 的服务商不带鉴权头直接请求（原先一律报「未配置 API Key」，本机服务从来翻译不了，见 worklog 2026-09-23-m5-fixes）。预设不带默认模型，模型始终由「获取模型列表」或手动添加得到。新增服务商 id 冲突时加 `-2`、`-3` 后缀（`uniqueProviderId()`）。

`DOCFLOW_MOCK_PROVIDER_URL` 存在时：所有服务商（不只是预设）在发请求时 baseUrl 被替换为 `${url}/v1`（openai/azure）、`${url}/anthropic`（anthropic）、`${url}/gemini`（gemini）。替换由 `withMockProviderUrl()` 在 `TranslationPools`、流水线的 `resolveProvider()`、`providers:listModels` / `providers:check` 里做，保存的设置不变。

## 4.3 请求构造（`request.ts`）

URL：

- chat：openai/azure → `${base}/chat/completions`；anthropic → `${base}/v1/messages`（base 已含 `/v1` 时不重复）；gemini → `${base}/v1beta/models/${model}:generateContent`（base 已含 `/v1beta` 时不重复；model 去掉前缀 `models/`）。
- models：openai/azure → `${base}/models`；anthropic → `${base}/v1/models`（base 已含 `/v1` 时不重复）；gemini → `${base}/v1beta/models`（base 已含 `/v1beta` 时不重复）。
- `base` 去掉尾部所有 `/`。`chatUrl`、`modelsUrl` 定义在 `src/shared/provider-url.ts`，`request.ts` 与 `providers.ts` 重新导出。

头：`Content-Type: application/json`，`Accept: application/json`，`User-Agent: DocFlow/<version>`（`app.getVersion()`）；鉴权：openai → `Authorization: Bearer <key>`；azure → `api-key: <key>`；anthropic → `x-api-key: <key>` + `anthropic-version: 2023-06-01`；gemini → `x-goog-api-key: <key>`。Key 为空时不加鉴权头（`authHeaders()` 不返回 Key 头）；anthropic 的 `anthropic-version` 与 Key 无关、总是发送（Messages API 缺它会报错，本机或自定义的 Anthropic 兼容服务无 Key 时也一样）。

体：

```ts
// openai / azure
{ model, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }], stream: false, ...(maxTokens ? { max_tokens: maxTokens } : {}) }
// anthropic
{ model, max_tokens: maxTokens ?? 8192, ...(system ? { system } : {}), messages: [{ role: 'user', content: user }] }
// gemini
{ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: [{ role: 'user', parts: [{ text: user }] }], ...(maxTokens ? { generationConfig: { maxOutputTokens: maxTokens } } : {}) }
```

翻译请求的 `system` 为空（pdf2zh 只发一条 user 消息，4.9），此时不带 system 字段；「检查模型」仍带 system。

`extraBody` 深合并进请求体（对象递归合并，数组与标量覆盖），例如 `{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}` 会保留我们的 `maxOutputTokens`。

温度策略：默认不传 `temperature`，用各服务商模型自身的默认值；需要固定温度的服务商（如 DeepSeek 官方翻译建议 1.3）由用户在 extraBody 里自行配置，代码不写死。（`buildRequest` 与 `ModelConfig` 都没有温度字段；2026 年主流模型多为推理模型，对非默认温度报 400 或忽略，见 [ADR-0011](../adr/0011-provider-presets-follow-research.md)、worklog 2026-09-23-presets 与 `docs/reference/providers/README.md`。）

超时：`REQUEST_TIMEOUT_MS = 900_000`（15 分钟，与 3.x 一致）。`buildRequest` 自带 `AbortSignal.timeout(900_000)`，但翻译请求的 signal 会被池替换为 `AbortSignal.any([调用方 signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])`，在拿到槽位后开始计时，同一请求内换 Key 重发（4.7）共用这 15 分钟。`postChat()`、`checkModel()` 与 `listModels()` 共用 `send()`：`fetch` 或读正文时抛出的任何异常（`fetch failed`、DNS、TLS、代理、超时）都由 `classifyNetworkError()` 转成 transient，message 是中文并说明下一步——超时（`TimeoutError`/`AbortError`）为 `翻译请求超时，请检查网络或代理设置后重试。`，其他为 `无法连接翻译服务（<原因>），请检查网络或代理设置，以及服务地址是否正确。`（原因优先取 `error.cause.message`，如 `connect ECONNREFUSED …`，同时放进 `snippet`）；不再把英文的 `TypeError: fetch failed` 直接给用户看。2xx 正文不是 JSON → transient `翻译服务返回的内容无法解析：<snippet>。请检查服务地址是否正确。`。

`fetch` 通过 `http.ts` 的 `createFetch(fetchFn?)` 注入：`DOCFLOW_FAKE_PROVIDERS=1` 时返回假 fetch（4.13），否则用传入的函数（生产传 `net.fetch`），都没有时退回 Node 全局 `fetch`。

## 4.4 响应解析（`response.ts`）

`postChat()` 与 `checkModel()` 先检查 HTTP 200 但正文含 `error` 对象的情况（某些网关）→ `classifyErrorObject(error)`：`error.code` 或 `error.status` 是 400–599 的数字时按那个状态分类（Gemini 风格的 `{ code: 401, … }`），否则按 4.5 的正文规则分类（`invalid_api_key` → credential、`model_not_found` → fatal …），正文无结论才是 transient。所以 200 里的「Key 无效」不会被当作暂时故障反复重试；`checkModel` 也显示这条分类后的 message，而不是「无法连接」。

```ts
type Finish = 'complete' | 'truncated' | 'refused'
type ChatReply = { text: string; finish: Finish; usage?: { input: number; output: number } }
```

- openai：`choices[0].message.content` 可能是字符串或数组（取 `type==='text'` 的 `text`，以及其他带 `text` 且 `thought !== true` 的项）；`finish_reason ∈ {length, max_tokens, model_length}` → truncated；`∈ {content_filter, safety, sensitive, refusal}` 或（文本为空且 `message.refusal` 非空）→ refused；usage `prompt_tokens/completion_tokens`。
- anthropic：拼接 `content[].type==='text'` 的 text；`stop_reason === 'max_tokens'` → truncated；`'refusal'` → refused；usage `input_tokens/output_tokens`。
- gemini：`promptFeedback.blockReason` 存在 → refused（空文本）；拼接 `candidates[0].content.parts[]` 中 `thought !== true` 的 text；`finishReason === 'MAX_TOKENS'` → truncated；`∈ {SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII, IMAGE_SAFETY}` → refused；usage `usageMetadata.promptTokenCount/candidatesTokenCount`。
- 所有文本经 `stripReasoning()`：去掉开头的 `<think>…</think>` / `<thinking>…</thinking>`（`/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i`）。

## 4.5 错误分类（`errors.ts`）

```ts
type ErrorKind =
  | 'transient'
  | 'rateLimited'
  | 'oversized'
  | 'output'
  | 'refused'
  | 'rejected'
  | 'credential'
  | 'fatal'
class ProviderError extends Error {
  kind: ErrorKind
  status?: number
  retryAfterMs?: number
  snippet: string
}
retryable = kind === 'transient' || kind === 'rateLimited'
```

按 HTTP 状态：401/402 → credential；403 → 正文同时含 `rate` 与 `limit` → rateLimited，否则按正文分类，正文不能证明是 Key 的问题时 → fatal（地区限制、代理拦截、Key 无权使用该模型都会回 403，不能一律说成 Key 无效）；404 → fatal；408/409/425/500/502/503/504/520–529 → transient；429 → rateLimited（正文含 `insufficient` 或 `exceeded your current quota` → credential）；413 → oversized；400/422 → 按正文分类；其他 4xx → rejected；2xx（4.4 的 200 + `error` 对象）→ 按正文分类，无结论时 transient；其余状态（含 501、505 等未列出的 5xx）→ transient；网络错误/中止 → transient（见 4.3）。403、404 不再一律当作 Key 无效，是 M5 复查第 10 条的改动（worklog 2026-09-23-m5-fixes）。

按正文（小写匹配，`classifyBody()`，按顺序取第一条）：`context length|context_length|maximum context|too many tokens|token limit|max_tokens|input is too long|prompt is too long` → oversized；`content_filter|content filter|safety|sensitive|violat|inappropriate|blocked` → refused；`invalid api key|invalid_api_key|incorrect api key|authentication|unauthorized|api key not valid|permission denied` → credential；`model not found|does not exist|no such model|unknown model|not supported model|model_not_found` → fatal；`rate limit|rate_limit|too many requests|quota exceeded|throttl` → rateLimited；`insufficient` 且含 `balance|quota|credit` → credential；否则无结论（400/422 → rejected，403 → fatal）。

`Retry-After` 头：秒数或 HTTP 日期，转毫秒，上限 300 s；rateLimited 无头时默认 5 s；其他种类有头时同样带上。

`redact(text, keys)`：把出现的所有 Key 替换为 `[redacted]`，目前只用在日志（`log/logger.ts` 的 `safeLogText()`）。`snippet(text)` 先 trim，超过 400 字符（`SNIPPET_CHARS`）截断并加 `…`。`classifyHttpError()` 生成的 message 固定为 `翻译服务返回错误（HTTP n）：<snippet>`（片段为空时没有 `：<snippet>`）。

文档因服务商错误失败时，调度器 `mapFailure()` 用 `userFacingProviderError()` 给出界面文案，credential、fatal、refused 记为永久失败，其他种类可重试。**只有 credential 才提 API Key**，其他都保留服务端原因（`<snippet>`）并说明下一步。按下表顺序取第一条匹配；没有状态码时省略 `（HTTP n）`，片段为空时省略 `：<snippet>`：

| 情况                                                                                                   | 文案                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| credential 且 message 含 `API Key`（KeyRing 的 `全部 N 个 API Key 都无法使用：…`、`未配置 API Key。`） | 原样显示 message                                                                                                             |
| credential，402 或 message/片段匹配 `/insufficient\|balance\|credit\|quota/`                           | `账户余额不足或 API Key 已欠费（HTTP n）。请到服务商后台充值，或在设置中更换 API Key。`                                      |
| credential，其他                                                                                       | `API Key 无效或已欠费（HTTP n）。请在设置中检查密钥。`                                                                       |
| fatal 且 message/片段匹配 `/model\|模型/`                                                              | `找不到这个模型（HTTP n）：<snippet>。请在设置中重新选择模型。`                                                              |
| 其他 403（不论种类）                                                                                   | `翻译服务拒绝了请求（HTTP 403）：<snippet>。请检查代理设置、所在地区是否受这个服务支持，以及 API Key 是否有权使用这个模型。` |
| 其他 404                                                                                               | `翻译服务返回错误（HTTP 404）：<snippet>。请在设置中检查服务地址是否正确。`                                                  |
| 其他 fatal                                                                                             | `翻译服务返回了无法恢复的错误（HTTP n）：<snippet>。`                                                                        |
| 没有 HTTP 状态（网络错误、重试用尽）                                                                   | 错误自身的 message，例如 `无法连接翻译服务（<原因>），请检查…`、`翻译请求多次重试后仍然失败：<原因>`                         |
| rateLimited                                                                                            | `翻译服务返回错误（HTTP n）：<snippet>。请求过于频繁，请稍后重试或在设置中降低并发数。`                                      |
| 其他                                                                                                   | `翻译服务返回错误（HTTP n）：<snippet>`                                                                                      |

## 4.6 模型列表与检查（`providers.ts`）

- `listModels(endpoint)`：最多 20 页。anthropic：`?limit=1000&after_id=<last>` 直到 `has_more=false`；gemini：`?pageSize=1000&pageToken=<next>`；openai：单页。解析：openai 读 `data[] | models[] | 根数组` 的 `id|name`、`owned_by`、`context_length`；anthropic 读 `data[].{id, display_name}`；gemini 读 `models[]` 中 `supportedGenerationMethods` 含 `generateContent` 的，id 去 `models/` 前缀，`displayName`、`inputTokenLimit`。去重、按 id 不区分大小写排序。请求头只有 `Accept` 与鉴权头。404/405 → 用户错误 `服务商不支持获取模型列表，请手动添加模型 ID。`；其他非 2xx 与网络错误都转成 `UserError('models_failed', …)`，界面直接显示：credential（401/402 或正文说明 Key 有问题）→ `服务商拒绝了这个 API Key（HTTP n）。请检查 API Key 是否正确、是否已欠费。`；网络错误 → `获取模型列表失败：<4.3 的网络错误 message>`；其他 → `获取模型列表失败（HTTP n）：<snippet>。请检查服务地址与 API Key，或手动添加模型 ID。`；正文不是 JSON → `服务商返回的模型列表无法解析。请检查服务地址是否正确，或手动添加模型 ID。`。每页超时 45 s（`LIST_MODELS_TIMEOUT_MS`）。
- `checkModel(endpoint, model)`：system `你是翻译引擎。把用户输入翻译成简体中文，只输出译文。`，user `Hello, world.`，anthropic 时 `max_tokens: 256`。成功 = 文本非空或 finish=truncated，返回 `{ ok: true, latencyMs, reply: snippet(text.trim(), 80) }`，设置页显示 `可用 · <n> ms · “<reply>”`。失败返回 `{ ok: false, message }`：HTTP 错误的 message 直接取 `classifyHttpError()`（`翻译服务返回错误（HTTP n）：<snippet>`，不经 `userFacingProviderError()`），空回复为 `译文为空`，200 里的 `error` 对象按 4.4 分类后取 message，网络错误为 4.3 的中文 message。超时 90 s（`CHECK_MODEL_TIMEOUT_MS`）。
- 两者的 Key 取请求里带的，没有时取该服务商已保存的 Key。

## 4.7 密钥（`keys.ts` + `settings/secrets.ts`）

- 存储：`<library>/secrets.bin` = `safeStorage.encryptString(JSON.stringify({ [providerId]: rawValue }))`；读取时 `decryptString`。解不开（换了电脑或用户、文件损坏）→ 文件改名为 `secrets.bin.broken-<时间戳>` 并记 warning，按没有 Key 继续打开文档库，不再拒绝打开（M5-9，worklog 2026-09-23-m5-fixes）。`safeStorage.isEncryptionAvailable()` 为 false → 读取时按空处理，保存时报用户错误 `这台电脑的系统钥匙串不可用，无法安全保存 API Key。`。内存中保存解密后的 Map；渲染进程只拿到 `keyConfigured`、`keyMasked`。
- `splitKeys(raw)`：按 `[,，\s;]+` 拆分、去空。`mask(raw)`（即 `src/shared/text.ts` 的 `maskKey`）：看第一个 Key，≥ 12 位时显示 `••••••••` + 末 4 位，否则 `••••••••`；多个时加 `（共 N 个）`。
- `KeyRing`（每个服务商一个，由 `TranslationPools` 创建）：轮询所有未下架的 Key。池里一次请求遇到 credential 且 Key 总数 > 1 → 该 Key 下架 600 s（`KEY_BENCH_MS`），同一请求立刻换下一个可用 Key 重发（不退避、仍占原来的槽位）；没有可用 Key 了 → credential `全部 N 个 API Key 都无法使用：<最近错误>`（永久失败）；只有 1 个 Key → 原样抛出 credential。同一请求又轮到已经试过的 Key（下架期满）→ 上面那条「全部…」消息降级为 transient，交给 `submit()` 退避重试。没有保存 Key 时：`keyOptional` 的服务商不带鉴权头请求（4.2），其他服务商报 credential `未配置 API Key。`。
- `secrets:set` 后作废该服务商的池与 KeyRing（4.8 `invalidate`），下一次请求读新 Key。

## 4.8 并发池（`pool.ts`）

每个服务商一个 `ProviderPool`：

- `configured` = `provider.concurrency`；`current` 初始 = configured；队列 FIFO（容量 `POOL_QUEUE_CAPACITY` = 4096，满了 `execute` 等待）。
- 自适应：收到 rateLimited → `current = max(1, floor(current/2))` 并清零成功计数，10 s（`RATE_LIMIT_COOLDOWN_MS`）冷却期内只降一次；在降过之后（current < configured）每累计 `max(current, 4)` 次成功 → `current = min(configured, current + max(1, floor(current/4)))`。
- `setConfigured(n)` 实时生效：降低时 current 立即压到 n，但不打断进行中的请求（新请求等占用数自然回落）；提高时若 current 没被降过（等于旧的 configured）就同步提高。`TranslationPools.configure(providers)` 在设置变化后对每个服务商调用它（没有池的会顺带建池）。
- `execute(request, signal, provider) → Promise<ChatReply>`：拿槽 → 选 Key（4.7）→ `postChat()` → 成功时更新自适应；rateLimited 时降速后原样抛出（重试由 `submit()` 负责）→ 释放。**池不保存服务商配置**：每个请求带上调用方（文档开始翻译时）的 provider 快照，所以两篇按不同设置开始的文档不会互相改掉对方的服务地址。上层统一走 `TranslationPools.execute(provider, request, signal)`，每次尝试都重新取池。（最初的实现由池保存配置，长文档每次提交都用旧快照改回配置，M5 复查第 37 条改为现在的做法。）
- 排队可中断：`signal` abort 时排队中的请求立刻离开队列（不占槽），进行中的请求随 fetch 一起中止；调用方取消（文档取消、应用退出）一律以 `UserError('cancelled')` 结束，不当作服务商错误、不发重试事件。
- `TranslationPools.invalidate(providerId?)`：丢弃该服务商（不传则全部）的池与 KeyRing，下一次请求重新读 Key 与并发数。`secrets:set`、`providers:save`、`providers:delete` 之后作废对应服务商，更改文档库时全部作废（换库后不会再用旧库的 Key，M5 复查第 9 条）；已在进行中的请求在旧池上完成。
- 文档级并发 `perDocumentConcurrency` 在 `translate-document.ts` 用 `pLimit` 风格的信号量 `createLimit(n)` 实现（自己写 20 行，不引库）。

## 4.9 逐段请求与提示词（照 pdf2zh `translator.py`，`pdf2zh-prompt.ts`）

> 2026-09-26 起照搬 PDFMathTranslate 1.9.11（[ADR-0016](../adr/0016-port-pdfmathtranslate.md)）。4.0.0 的分批、占位符保护、回复校验、拆分与隔离重译（原 4.9–4.11）全部删除。

- **一段一请求**：03 章 §3.8 列出的每个段落字符串（`sstk`，空白串与纯 `{vN}` 串不送）单独请求一次，文档内按 `perDocumentConcurrency` 并发（pdf2zh 的 `ThreadPoolExecutor`）。
- **消息**：只有一条 user 消息，`system` 为空。内容 = `safe_substitute(模板, { lang_in: 'en', lang_out: 'zh', text: 段落 })`（Python `string.Template` 规则：`$name`、`${name}`、`$$`，未知变量原样保留）。默认模板即 pdf2zh `BaseTranslator.prompt` 的默认消息（`DEFAULT_SYSTEM_PROMPT`，一字不改）：

  ```
  You are a professional, authentic machine translation engine. Only Output the translated text, do not include any other text.

  Translate the following markdown source text to ${lang_out}. Keep the formula notation {v*} unchanged. Output translation directly without any additional text.

  Source Text: ${text}

  Translated Text:
  ```

  设置 → 高级 →「翻译提示词」编辑的就是这个模板（对应 pdf2zh 的 `--prompt`，settings 字段名仍是 `translation.systemPrompt`）。4.0.0 的默认提示词（`LEGACY_SYSTEM_PROMPT`）在读取设置时换成新默认；4.0.0 排队的文档快照里带着旧提示词，请求时也按新默认处理。

- **回复**（`OpenAITranslator.do_translate`）：`strip()` → 去掉开头的 `^<think>.+?\n*(</think>|\n)*(</think>)\n*` → 再 `strip()`（Python `str.isspace` 的空白）。不校验 `{vN}`：丢失、多出或越界的标记在排版时按 pdf2zh 的规则处理（越界的跳过，丢失的公式就不画）。`maxTokens` = `runtime.llm.maxOutputTokens > 0 ? 它 : undefined`；输出被截断（finish = truncated）照样采用。
- **拒绝**：finish = refused（内容过滤，没有正文）→ 抛 `ProviderError('refused')`，按 4.11 保留原文。pdf2zh 在这里会因 `None.strip()` 抛异常后无限重试。
- **温度**：不传（[ADR-0011](../adr/0011-provider-presets-follow-research.md)）。pdf2zh 的 OpenAI 翻译器传 `temperature: 0`；DocFlow 的服务商请求层保持原样，需要时由用户在 extraBody 里配置。
- `settings.translation.llm` 的 `chunkChars`、`maxSegmentsPerRequest`、`maxRequestChars` 不再使用（保留在 schema 里以兼容旧 settings.json，界面已去掉）。

## 4.10 （已删除）

原「校验与恢复」。pdf2zh 不校验译文。

## 4.11 失败处理（`translate-document.ts`）

- **段落级** `translateSegment`：请求成功就用回复；请求抛出 `UserError`（取消、连续拒绝）、fatal/credential、`RetriesExhaustedError` → 向上抛，中止整篇文档；其他 `ProviderError`（rejected、oversized、refused、output）→ **这一段保留原文**，发 warning 事件 `第 N 段翻译失败，已保留原文`（detail 为原因）。pdf2zh 的 `worker` 对任何异常每秒重试、不停止；DocFlow 保留自己的传输层重试与文档级失败，见下。
- **文档级**：任何段落向上抛错时，内部 `AbortController` 中止其余请求，`translateDocument` 抛出第一个错误。缓存命中数在结束时发一条 info `缓存命中 N 段`。`keptChars > 400 && keptChars × 5 > totalChars` → 永久失败 `mostly_untranslated`。连续 `REJECTED_STREAK_LIMIT (6)` 次 rejected → 永久失败 `翻译服务连续拒绝了 6 个请求，已停止处理`。
- **传输级** `submit()`（不变）：最多 `SUBMIT_ATTEMPTS (8)` 次，每次经 `TranslationPools.execute()` 取池；fatal/credential 立即抛出；rejected 计入连续拒绝后抛出；不可重试的种类立即抛出；transient、rateLimited 退避重试：`backoff = min(2^(attempt−1), 32) × 1000 ms`，`delay = max(retryAfterMs ?? backoff, backoff/2) + jitter(0–2040 ms)`；前 `RETRY_NOTICES (12)` 次及每个请求第 3 次起的失败发 warning `翻译请求失败（<原因>），<n> 秒后重试`；用尽 → `RetriesExhaustedError`（可重试的文档失败，调度器稍后自动重试，已翻译的段落在缓存里）。

取消：所有 await 点检查 `signal.aborted`；`fetch` 传入同一 `signal`；重试等待与并发池排队都随 `signal` 立即结束。

## 4.12 缓存（`cache.ts`）

- 文件：`documents/<id>/work/translation-cache.json`：`{ version: 1, fingerprint, entries: { [sha256(原文)]: { text, at } } }`。
- `fingerprint = sha256(JSON.stringify({ version: 1, translator: `llm:${type}:${baseUrl}:${model}`, chunkChars, maxSegmentsPerRequest, maxRequestChars, systemPrompt }))`——改提示词或模型即失效。
- 命中：按原文取出存的译文，原样使用（pdf2zh `TranslationCache.get`，不再校验）。
- 写入：每 2 s 或每 20 条新增落盘（原子写），阶段结束再落盘；写失败只在处理记录里记一次 warning `翻译缓存写入失败（不影响翻译结果）：<原因>`。
- 任务成功归档后删除整个 `work/`；失败、取消时保留。

## 4.13 假服务商模式

`DOCFLOW_FAKE_PROVIDERS=1`：`http.ts` 的 `createFetch()` 返回不走网络的 `fakeFetch`（`fake.ts`），对任意 chat 请求返回同时含 openai/anthropic/gemini 三种形状的确定性译文：用户消息是 pdf2zh 提示词时取出 `Source Text: ` 与 `\n\nTranslated Text:` 之间的原文，译文 = 原文（`{vN}` 原样保留）+ 后缀 `〔测试译文〕`，空白原文不加（旧的 `<segment>` 批量格式仍识别，只供检查模型等用途）；GET `…/models` 返回 `fake-model`；`checkModel` 照常请求，得到 `Hello, world.〔测试译文〕`，设置页显示为「可用」。打开文档库时若设置里没有 `fake` 服务商就自动加入 `fakeProvider()`（id `fake`、名称 `假服务商`、type openai、baseUrl `http://127.0.0.1:9`、模型 `fake-model`「假模型」，本机地址所以无需 Key）；流水线找不到文档记录的服务商时也回退到它。用于开发时不花钱跑通全流程与截图。

## 4.14 模块接口

```ts
// shared/provider-url.ts（request.ts、providers.ts 重新导出）
export function chatUrl(p: Pick<ProviderConfig, 'type' | 'baseUrl'>, model: string): string
export function modelsUrl(p: Pick<ProviderConfig, 'type' | 'baseUrl'>): string

// request.ts（providers.ts 重新导出 buildRequest）
export function buildRequest(
  p: ProviderConfig,
  model: string,
  system: string,
  user: string,
  maxTokens: number | undefined,
  appVersion: string,
  key: string | undefined,
): { url: string; init: RequestInit }

// providers.ts
export type CheckResult =
  { ok: true; latencyMs: number; reply: string } | { ok: false; message: string }
export async function listModels(
  p: ProviderConfig,
  key: string | undefined,
  fetchFn: FetchFn,
): Promise<ModelInfo[]>
export async function checkModel(
  p: ProviderConfig,
  key: string | undefined,
  model: string,
  fetchFn: FetchFn,
  appVersion?: string, // 默认 '4.0.0'
): Promise<CheckResult>
export async function postChat(
  p: ProviderConfig,
  model: string,
  system: string,
  user: string,
  maxTokens: number | undefined,
  key: string | undefined,
  fetchFn: FetchFn,
  signal: AbortSignal,
  appVersion: string,
): Promise<ChatReply>

// pool.ts
export type ChatRequest = { model: string; system: string; user: string; maxTokens?: number }
export class ProviderPool {
  constructor(
    p: ProviderConfig, // 只用于初始并发数与默认 provider
    keys: KeyRing,
    fetchFn: FetchFn,
    options?: { clock?: Clock; appVersion?: string },
  )
  execute(req: ChatRequest, signal: AbortSignal, provider?: ProviderConfig): Promise<ChatReply>
  setConfigured(n: number): void
  stats(): PoolStats
}
export class TranslationPools {
  constructor(
    fetchFn: FetchFn,
    readRawKey: (providerId: string) => string | undefined,
    clock?: Clock,
    appVersion?: string,
  )
  get(p: ProviderConfig): ProviderPool
  execute(p: ProviderConfig, req: ChatRequest, signal: AbortSignal): Promise<ChatReply>
  configure(providers: ProviderConfig[]): void
  resetKeys(providerId: string): void
  invalidate(providerId?: string): void
}

// translate-document.ts
export async function translateDocument(input: {
  segments: Segment[]
  provider: ProviderConfig
  model: string
  runtime: TranslationRuntime
  pools: TranslationPools
  cache: TranslationCache
  signal: AbortSignal
  onProgress(done: number, total: number): void
  onEvent(e: EventInput): void
  hooks?: TranslateHooks // 测试注入重试等待 delay 与抖动 jitterMs
}): Promise<{
  results: TranslatedParagraph[]
  keptChars: number
  totalChars: number
  usage: { input: number; output: number }
}>
```

单测覆盖（08 章）：URL 构造 × 4 类型、请求体与 extraBody 合并（含空 system）、响应解析（含 `<think>`、refusal、truncated）、错误分类表、Retry-After、KeyRing 轮换与下架、池自适应 100→50→62→…→100、pdf2zh 提示词逐字比对、`safe_substitute`、回复清理、逐段请求、失败保留原文、缓存命中。
