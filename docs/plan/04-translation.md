# 04 翻译子系统

> 服务商、请求、响应、错误分类、密钥、并发池与传输级重试（4.1–4.8、4.11 末条）是 3.x Rust 实现（`engine/src/providers.rs`、`pipeline/translate.rs`、`pipeline/translate_native.rs`、`translation_pool.rs`、`secrets.rs`）的 TypeScript 移植，除本章注明的改动外行为与参数一致。「翻译哪些段、怎样组织请求、怎样检查译文、术语表」（4.9–4.12、4.15）自 4.1.0 起照搬 BabelDOC 0.6.4（PDFMathTranslate-next 2.9.0 的引擎）的 `ILTranslatorLLMOnly`、`ILTranslator`、`AutomaticTermExtractor` 与 `Glossary`，见 [ADR-0018](../adr/0018-port-babeldoc-features.md)（4.0.x 照 pdf2zh 逐段请求，ADR-0016，已替换）。模块位于 `src/main/translate/`（BabelDOC 部分在 `babeldoc/`），全部是可在 vitest 里直接测的纯 Node 代码：`http.ts` 不引用 Electron，生产用的 `net.fetch` 由 `app/session.ts` 注入。提示词模板在 `babeldoc/templates.ts`（BabelDOC 原文），常量在 `src/shared/constants.ts`，URL 拼接在 `src/shared/provider-url.ts`（设置页也用它显示「请求地址」）。

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
  perDocumentConcurrency: z.number().int().min(1).max(1000).default(100), // BabelDOC pool_max_workers（4.8）
  systemPrompt: z.string().max(12_000), // BabelDOC custom_system_prompt：替换提示词开头的角色行，'' = 默认角色（4.9）
  minTextLength: z.number().int().min(1).max(1000).default(5), // BabelDOC min_text_length
  autoExtractGlossary: z.boolean().default(true), // BabelDOC auto_extract_glossary（pdf2zh-next 默认开，4.15）
  richText: z.boolean().default(true), // false = disable_rich_text_translate（不用样式占位符，4.9）
})
```

`models` id 唯一与 `extraBody` 禁用键由 `.strict()` 之后的 `.superRefine()` 检查（报错 `models id 必须唯一`、`extraBody 不得包含 <键>`）；禁用键列表是 `constants.ts` 的 `EXTRA_BODY_FORBIDDEN`。

`TranslationRuntime` 整个进文档的 `settingsSnapshot`（05 §5.4）。4.1.0 新增的三个字段都有默认值，4.0.x 的 settings.json 与排队文档的快照读进来时自动补上。`llm.chunkChars`、`maxSegmentsPerRequest`、`maxRequestChars` 自 ADR-0016 起不再使用，只为兼容旧 settings.json 留在 schema 里。`systemPrompt` 的迁移见 4.9 末尾。

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

翻译请求的 `system` 为空（BabelDOC 的整条提示词作为一条 user 消息发送，4.9），此时不带 system 字段；「检查模型」仍带 system。

`extraBody` 深合并进请求体（对象递归合并，数组与标量覆盖），例如 `{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}` 会保留我们的 `maxOutputTokens`。

温度策略：默认不传 `temperature`，用各服务商模型自身的默认值；需要固定温度的服务商（如 DeepSeek 官方翻译建议 1.3）由用户在 extraBody 里自行配置，代码不写死。（`buildRequest` 与 `ModelConfig` 都没有温度字段；2026 年主流模型多为推理模型，对非默认温度报 400 或忽略，见 [ADR-0011](../adr/0011-provider-presets-follow-research.md)、worklog 2026-09-23-presets 与 `docs/reference/providers/README.md`。pdf2zh-next 默认也不发温度与 JSON mode，ADR-0018。）

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
- 所有文本经 `stripReasoning()`：去掉开头的 `<think>…</think>` / `<thinking>…</thinking>`（`/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i`）。翻译请求的回复之后还按 pdf2zh-next 再清理一次（4.9）。

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
- 文档内并发 `perDocumentConcurrency`（= BabelDOC 的 `pool_max_workers`）：批量请求与逐段回退各有一个这么大的并发池（`babeldoc/translator.ts` 的 `createPool(n)`，按提交顺序排队；批量还没跑完时回退已经开始，所以一篇文档最多约 2 × n 个请求同时在路上），术语抽取用 n 个 worker 依次取批（`babeldoc/terms.ts`）。都是自己写的十几行，不引库；实际同时发出的请求数仍受服务商池的 `current` 限制。

## 4.9 批量请求与提示词（照 BabelDOC `ILTranslatorLLMOnly`，`babeldoc/`）

> 4.0.x 照 pdf2zh 1.9.11 一段一请求，提示词是带 `$text` 的模板（ADR-0016）；4.1.0 起改为 BabelDOC 0.6.4 的多段 JSON 请求（[ADR-0018](../adr/0018-port-babeldoc-features.md)），`pdf2zh-prompt.ts` 已删除。文件：`babeldoc/paragraphs.ts`（BabelDOC 眼中的段落与过滤）、`translator.ts`（分批、请求、检查、回退）、`prompts.ts` + `templates.ts`（提示词）、`placeholders.ts`（占位符）、`text.ts`（token 计数与 Python 字符串语义）、`glossary.ts` + `terms.ts`（4.15）。`translate-document.ts` 先抽取术语（4.15）再翻译，所有请求都经 4.11 的 `submit()` 与 4.12 的缓存。

- **段落**（`buildParagraphs(analysis)`）：分析结果（03 章，v5）每个单元的每个 pdf2zh 段落一项，id 仍是 `${unit.id}#${index}`。记下页号、版面类别 `label`（模型框名，如 `title`、`plain text`）、`top`（段落框 `y1`）、组成（连续同样式的文字字符为一个片段，每个公式一个片段；同样式照 `is_same_style`：字体资源名相同、字号差 < 0.02、图形状态相同）、基准样式（`_calculate_base_style`：各字符样式求交，字体、字号不同时取众数）与段落文本 `unicode`（`get_paragraph_unicode`：文字与公式字符按字距和换行插空格，NFKC，连续空白合为一个空格后 strip）。竖排字符在 pdf2zh 分段里已归入公式（03 章 §3.7），不另判竖排段。
- **不送翻译**（这些段按原字形原样画，03 章）：`(cid:N)` 字符超过 80% 的段；段落文本少于 `minTextLength`（默认 5，Python `len`，按码点）的段；纯数字段（strip 后匹配 `^-?\d+(\.\d+)?$`，`\d` 为任意 Unicode 十进制数字）；除公式外只有空白的段（`is_placeholder_only_paragraph`）；没有组成或只有一个公式的段；换成占位符后送翻译文本少于 `minTextLength` 的段。
- **分批**（`translateParagraphs`，照 `ILTranslatorLLMOnly.translate`）。正文段 = 版面类别为 `text`、`plain text` 或 `paragraph_hybrid`，且不是 cid 段、不短于 `minTextLength`。按顺序：
  1. 跨页（`process_cross_page_paragraph`）：相邻两页都有正文段时，上一页最后一个正文段与下一页第一个正文段成对为一批；
  2. 跨栏（`process_cross_column_paragraph`）：每页内相邻两个正文段，后一段 `top` 比前一段高 20 pt 以上（`p2.top − p1.top > 20`）时成对为一批；
  3. 其余（`process_page`）：逐页按顺序累积还没进批的段（跳过 cid、过短、纯数字、只有占位符的段），累计 token > 200 或段数 > 5 时成批，页末余下的也成一批——每批最多 6 段，不跨页。

  一段只进一批。批的 token 数 = 各段 `unicode` 的 token 之和。执行时批按 token 数降序（同数按建立顺序）进 4.8 的批量池（BabelDOC `PriorityThreadPoolExecutor` 的优先级 `1048576 − tokens`）。

- **上下文**：`title` = 全文第一个版面类别为 `title` 的段；`localTitle` = 成批时最近的 `title` 段（`process_page` 按页顺序扫描时更新；跨页、跨栏的成对批在此之前建立，所以是全文第一个标题）。两者是同一段时提示词只写第一条。
- **token 计数**：o200k_base（BabelDOC 的 `tiktoken.encoding_for_model("gpt-4o")`），用 `gpt-tokenizer` 的 `encode(text, { disallowedSpecial: new Set() })`：特殊 token 的字面串按普通文本计，出错计 0。
- **送翻译的文本**（`getTranslateInput`，照 `ILTranslator.get_translate_input`，占位符形状是 pdf2zh-next OpenAI 翻译器的）：
  - 只有一个文字片段：就用段落文本，没有占位符。
  - 公式 → `{vN}`；与基准样式不同的文字片段 → `<style id='N'>…</style>`。N 在段内从 1 起，公式后 +1、样式片段后 +2；段落文本开头正好是同形占位符时顺延（Python `re.match` 语义）。文本由 `get_char_unicode_string` 拼出。
  - 文字片段满足以下之一时不加样式占位符：与基准样式相同；只差字号且字号比在 (0.7, 1.3)；只差字体且两种字体经 FontMapper（按设置 `pdf.fontFamily`，03 章）映射到同一个内置字体。设置 `translation.richText` 关、分析结果 `ocrWorkaround` 为真（带文字层的扫描件，03 §3.3）或段落没有基准样式时，一律不加。
  - 占位符超过 40 个时，这一段改为不加样式占位符重算（公式照旧）。
  - 原文里本来就有的形似占位符的串（`{vN}`、`<style id='N'>`、`</style>`）记下来，拆回时保留。
- **拆回译文**（`parseTranslateOutput`，照 `parse_translate_output`）：按占位符正则（不区分大小写、容许空白；样式片段非贪婪匹配到 `</style>`）切开译文：公式占位符 → 该公式（原样重画）；样式片段 → 片段内文字去掉空格后与原文相同时用原字形（`original`），否则按该片段的样式排译文；其余文字用基准样式。模型编造的同形占位符（既不在原文里、也不是本段的）删掉；丢失的公式就不画。结果写进 `TranslatedParagraph.comps` 交给写回（03 章）。
- **提示词**（`prompts.ts`；模板是 BabelDOC 原文，用 Python 导出后生成 `templates.ts`，逐字比对过；按 `string.Template.substitute` 语义填 `$name`）：
  - 角色块（`_build_role_block`）：`systemPrompt` 为空时是

    ```
    You are a professional zh-CN native translator who needs to fluently translate text into zh-CN.

    Follow all rules strictly.
    ```

    非空时取 `trim()` 后的内容，不含 `Follow all rules strictly.` 就另起一行补上。

  - 批量（`il_translator_llm_only.PROMPT_TEMPLATE`）：角色块 → `## Structure Rules`、`## Do NOT Modify` → 术语表用法（`## Glossary`，本批命中术语时）→ `## Output Format`、`## Style`、`### Example` → 上下文（`## Contextual Hints for Better Translation`：`1. First title in full text: …`、`2. The most recent title is: …`）→ 术语表（`## Glossary Tables`，每个命中的术语表一张 `| Source Term | Target Term |` 表，条目排序）→ `## Here is the input:` 与 JSON。JSON 是 `json.dumps(…, ensure_ascii=False, indent=2)` 形式的 `[{ "id": 0, "input": 送翻译的文本, "layout_label": 版面类别 }, …]`，id 从 0 起，只含有送翻译文本的段。
  - 逐段（`il_translator.PROMPT_TEMPLATE`，4.10 的回退用）：角色块 → `## Rules` → 术语表（`## Glossary`）→ 上下文（`## Context / Hints`：`First title in the full text`、`The most recent title is`）→ `## Output` → `Now translate the following text:` 与文本。公式占位符提示（BabelDOC 默认关）不加。
  - 目标语言写 `zh-CN`（`LANG_OUT`，pdf2zh-next 界面选「简体中文」时传给 BabelDOC 的值）。
  - 请求：只有一条 user 消息，`system` 为空；`maxTokens` = `runtime.llm.maxOutputTokens > 0 ? 它 : 不传`；不开 JSON mode、不传温度（[ADR-0011](../adr/0011-provider-presets-follow-research.md)）。
- **回复**：4.4 的解析之后照 pdf2zh-next `_remove_cot_content`：Python `strip()`，再去掉开头的 `<think>…</think>`（`/^<think>[\s\S]+?<\/think>/`）；这就是存进缓存、交给 4.10 的回复。输出被截断（finish = truncated）照样采用（JSON 不完整时走 4.10 的整批回退）。finish = refused（内容过滤，没有正文）→ 抛 `ProviderError('refused', '服务商拒绝翻译这一段')`，不进缓存，按 4.10、4.11 回退或保留原文。
- **角色提示词与迁移**：设置 → 高级 →「角色提示词」编辑的是 `translation.systemPrompt`（字段名沿用），默认 `''`（`DEFAULT_SYSTEM_PROMPT`）。4.0.x 的值不再适用：读取 settings.json 时 `upgradePrompt()` 把 4.0.0 的默认提示词（`LEGACY_SYSTEM_PROMPT`）、4.0.1 的 pdf2zh 模板（`PDF2ZH_PROMPT_TEMPLATE`）和任何含 `$text` / `${text}` 的提示词清空（`isStalePrompt()`）；4.0.x 排队的文档快照里的旧提示词在翻译阶段同样按 `''` 处理，缓存指纹也用清空后的值。

## 4.10 批量结果检查与逐段回退（`ILTranslatorLLMOnly.translate_paragraph`、`ILTranslator`）

> 4.0.0 的「校验与恢复」在 4.0.1 删除（pdf2zh 不校验译文）；4.1.0 起这里是 BabelDOC 的检查与回退。

- **解析**：回复 strip 后按 `_clean_json_output` 去掉首尾的 `<json>` / `</json>` 与 Markdown 代码围栏（开头 ` ```json ` 或 ` ``` `，结尾 ` ``` `），再 `JSON.parse`。是单个对象且其 `output`（没有这个键时看 `input`）为真值 → 当作一项的列表；不是列表 → 失败。每项必须有 `id`（按 Python `int()` 转换），译文取 `output`（没有这个键时取 `input`）；id 重复时后一个覆盖。
- **整批回退**：JSON 解析失败、不是列表、某项没有 `id` 或 `id` 越界、项数与输入不符（`Translation results length mismatch. Expected: N, Got: M`），或请求抛出不结束文档的错误（4.11）→ 这一批每一段都改走逐段回退。
- **逐项检查**：原送翻译文本与译文先各自把 `[. 。…，]{20,}` 换成 `.`，然后依次判断：译文不是字符串；与原文相同且原文 > 10 token；原文 0 token；token 比（译文 / 原文）不在 (0.3, 3) 内；编辑距离（`python-Levenshtein` 语义，按码点）< 5 且原文 > 20 token。命中任一条 → 这一段逐段回退；都不命中 → 采用处理后的译文。
- **逐段回退**（`ILTranslator.translate_paragraph`，`use_as_fallback`）：用逐段提示词（4.9，带该批的上下文与术语表）单独请求，进 4.8 的回退池；回复同样把 `[. 。…，]{20,}` 换成 `.` 后直接采用，不再检查。请求出错（不结束文档的）→ 这一段保留原文（4.11）。
- 翻译结束时有回退则发 info `N 段的批量译文未通过检查，已逐段重译`（N 含整批回退的每一段）。

## 4.11 失败处理（`translate-document.ts`）

- **结束整篇文档的错误**（`endsDocument()`）：`UserError`（取消、连续拒绝）、`RetriesExhaustedError`、`ProviderError` 的 fatal / credential。第一个这样的错误出现时，内部 `AbortController` 中止其余请求（术语抽取、批量与回退都停下，之后排到的任务什么也不做），`translateDocument` 抛出这个错误。
- **其余错误**（rejected、oversized、refused、output，以及 4.10 的 JSON 与检查失败）：批量请求 → 整批逐段回退（4.10）；逐段回退的请求 → **这一段保留原文**，发 warning `第 P 页有一段翻译失败，已保留原文`（detail 为原因），结果记为 `kept: true`、`text` = 段落文本；术语抽取的一批 → 丢掉这批（4.15）。pdf2zh / BabelDOC 对异常的重试方式不照搬，DocFlow 保留自己的传输层重试与文档级失败，见下。
- **文档级**：`keptChars > 400 && keptChars × 5 > totalChars` → 永久失败 `mostly_untranslated`（按 Python `len` 统计有译文或保留原文的段；4.9 过滤掉、没有送翻译的段不计）。连续 `REJECTED_STREAK_LIMIT (6)` 次 rejected → 永久失败 `翻译服务连续拒绝了 6 个请求，已停止处理`（code `internal`）。
- **进度**：`onProgress({ fraction, current, total, message })`，`fraction` 是整个翻译阶段的进度。开启自动术语抽取时前一半是抽取：`fraction = 已处理段数 / 全部段数 / 2`，`message` 为 `抽取术语 X / Y 段`（被过滤的段立即计入）；后一半是翻译：`fraction = (1 + 已完成段数 / N) / 2`，`message` 为 `已翻译 X / N 段`，N = 进了批的段数（续跑时术语来自检查点，也从一半开始）。关闭时 `fraction = 已完成段数 / N`。流水线把 `fraction` 换算成 30–79%，每次写一条带 `current/total` 的事件（05 §5.5）。`translateDocument` 自己的逐段事件（`已翻译 d / N 段`）被 `translateStage` 丢掉，不重复写。
- **处理记录**：info `抽取术语…`、`抽取术语：N 条` / `抽取术语：没有得到术语`（4.15）；info `开始翻译：N 段，合并为 M 个请求`（分完批时）；warning 保留原文（上面）与重试（下面）；结束时有才发 info `缓存命中 N 个请求`、`N 段的批量译文未通过检查，已逐段重译`。成功事件由流水线写（05 §5.5）。
- **传输级** `submit()`（不变）：最多 `SUBMIT_ATTEMPTS (8)` 次，每次经 `TranslationPools.execute()` 取池；fatal/credential 立即抛出；rejected 计入连续拒绝后抛出；不可重试的种类立即抛出；transient、rateLimited 退避重试：`backoff = min(2^(attempt−1), 32) × 1000 ms`，`delay = max(retryAfterMs ?? backoff, backoff/2) + jitter(0–2040 ms)`；前 `RETRY_NOTICES (12)` 次及每个请求第 3 次起的失败发 warning `翻译请求失败（<原因>），<n> 秒后重试`；用尽 → `RetriesExhaustedError`（可重试的文档失败，调度器稍后自动重试，已翻译的段落在缓存里）。

取消：所有 await 点检查 `signal.aborted`；`fetch` 传入同一 `signal`；重试等待与并发池排队都随 `signal` 立即结束。

## 4.12 缓存（`cache.ts`）

- 文件：`documents/<id>/work/translation-cache.json`：`{ version: 1, fingerprint, entries: { [sha256(完整提示词)]: { text, at } } }`。键是整条提示词（BabelDOC `llm_translate` 的缓存键），其中已含角色、上下文、术语表与 JSON 输入；批量、逐段回退与术语抽取三种请求都经过它。
- ``fingerprint = sha256(JSON.stringify({ version: 2, translator: `llm:${type}:${baseUrl}:${model}`, maxOutputTokens, systemPrompt }))``：换服务地址、模型、最大输出或角色提示词即整体失效。4.0.x 的缓存（指纹 version 1、按原文取）读进来一律不命中。
- 命中：直接返回存的回复（已做 4.9 的清理），不发请求，仍走 4.10 的解析与检查；命中数在结束时发 info `缓存命中 N 个请求`。
- 写入：拿到回复（refused 除外）即存；每 2 s（`CACHE_FLUSH_MS`）或每 20 条（`CACHE_FLUSH_EVERY`）新增落盘（原子写），阶段结束再落盘；写失败只在处理记录里记一次 warning `翻译缓存写入失败（不影响翻译结果）：<原因>`。
- 同一个指纹也用于术语检查点 `work/auto-glossary.json`（4.15）。
- 任务成功归档后删除整个 `work/`；失败、取消时保留。

## 4.13 假服务商模式

`DOCFLOW_FAKE_PROVIDERS=1`：`http.ts` 的 `createFetch()` 返回不走网络的 `fakeFetch`（`fake.ts`），对任意 chat 请求返回同时含 openai/anthropic/gemini 三种形状的确定性回复，按最后一条用户消息认提示词：批量提示词（`## Here is the input:\n\n` 之后的 JSON）→ `[{ id, output: input + '〔测试译文〕' }]`；逐段提示词（`Now translate the following text:\n\n` 之后的文本）→ 原文 + `〔测试译文〕`；术语抽取提示词（含 `Input Text:\n```\n`）→ `[]`（所以没有自动术语表）；其他 → 用户消息 + 后缀。空白原文不加后缀，占位符随原文原样带回。只有一两个 token 的短段加上后缀后 token 比 ≥ 3，会走 4.10 的逐段回退，结果相同。GET `…/models` 返回 `fake-model`；`checkModel` 照常请求，得到 `Hello, world.〔测试译文〕`，设置页显示为「可用」。打开文档库时若设置里没有 `fake` 服务商就自动加入 `fakeProvider()`（id `fake`、名称 `假服务商`、type openai、baseUrl `http://127.0.0.1:9`、模型 `fake-model`「假模型」，本机地址所以无需 Key）；流水线找不到文档记录的服务商时也回退到它。用于开发时不花钱跑通全流程与截图。

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

// cache.ts
export function cacheFingerprint(
  p: ProviderConfig,
  model: string,
  runtime: TranslationRuntime,
): string
export class TranslationCache {
  constructor(path: string, fingerprint: string, onWarning?: (message: string) => void)
  load(): Promise<void>
  start(): void // 定时落盘
  stop(): void
  get(prompt: string): string | undefined
  set(prompt: string, text: string): void
  flush(): Promise<void>
}

// translate-document.ts
export type TranslateOptions = {
  minTextLength: number
  disableRichText: boolean // !runtime.richText || analysis.ocrWorkaround
  fontFamily: PrimaryFontFamily // 当时的 settings.pdf.fontFamily（FontMapper，4.9）
  userGlossaries: readonly Glossary[] // 文档的用户术语表（4.15）
  autoExtractGlossary: boolean
  savedAutoGlossary?: Glossary | null // 检查点里的自动术语表；undefined = 重新抽取
}
export function endsDocument(error: unknown): boolean // 4.11
export async function translateDocument(input: {
  analysis: AnalysisResult
  provider: ProviderConfig
  model: string
  runtime: TranslationRuntime
  options: TranslateOptions
  pools: TranslationPools
  cache: TranslationCache
  signal: AbortSignal
  onProgress(done: number, total: number): void
  onEvent(e: EventInput): void
  onAutoGlossary?(glossary: Glossary | null): Promise<void> // 抽取完、翻译前调用（写检查点）
  hooks?: TranslateHooks // 测试注入重试等待 delay 与抖动 jitterMs
}): Promise<{
  results: TranslatedParagraph[] // { id, text, kept, comps? }
  keptChars: number
  totalChars: number
  usage: { input: number; output: number }
  autoGlossary: Glossary | null
}>

// babeldoc/paragraphs.ts
export function buildParagraphs(analysis: AnalysisResult): BdParagraph[]

// babeldoc/translator.ts
export async function translateParagraphs(
  paragraphs: readonly BdParagraph[],
  options: {
    minTextLength: number
    disableRichText: boolean
    customPrompt: string // systemPrompt
    mapper: FontMapper
    glossaries: readonly Glossary[] // glossariesForTranslation() 的结果
    concurrency: number
  },
  hooks: {
    llm(prompt: string): Promise<string> // 缓存 + submit() + 4.9 的回复清理
    isFatal(error: unknown): boolean
    onFatal(error: unknown): void
    onPlanned(paragraphs: number, batches: number): void
    onParagraphDone(): void
    onFallback(paragraph: BdParagraph, reason: string): void
    onKept(paragraph: BdParagraph, error: unknown): void
  },
): Promise<Map<string, { id: string; text: string; comps: OutputComp[] }>>

// babeldoc/placeholders.ts
export function getTranslateInput(p: BdParagraph, options: InputOptions): TranslateInput | undefined
export function parseTranslateOutput(input: TranslateInput, output: string): OutputComp[]

// babeldoc/glossary.ts
export class Glossary {
  constructor(name: string, entries: readonly GlossaryEntry[])
  readonly name: string
  readonly entries: GlossaryEntry[] // { source, target, targetLanguage? }
  activeEntries(text: string): Array<[string, string]>
  toCsv(): string
}
export function glossaryFromCsv(name: string, bytes: Uint8Array, langOut: string): Glossary // 缺列抛 GlossaryFormatError

// babeldoc/terms.ts
export async function extractTerms(
  paragraphs: readonly BdParagraph[],
  userGlossaries: readonly Glossary[],
  concurrency: number,
  hooks: TermHooks, // llm、isFatal、onFatal、onBatchDone、onError
): Promise<{ glossary: Glossary | null; pairs: Array<[string, string]> }>
export function glossariesForTranslation(
  user: readonly Glossary[],
  auto: Glossary | null,
  autoExtract: boolean,
): Glossary[]
```

单测覆盖（08 章）：URL 构造 × 4 类型、请求体与 extraBody 合并（含空 system）、响应解析（含 `<think>`、refusal、truncated）、错误分类表、Retry-After、KeyRing 轮换与下架、池自适应 100→50→62→…→100；BabelDOC 部分（`babeldoc/*.test.ts`）：每批 6 段、短段/纯数字/cid 不送、跨页与跨栏成对、页码范围外的空页、标题上下文、照抄原文与条数不符时回退、代码围栏、回退失败保留原文、致命错误只结束一次，占位符的编号、顺延、40 个上限与拆回，术语表 CSV、匹配、提示词与自动抽取；`translate-document.test.ts`（mock 服务或注入 fetch）：批量与缓存命中、拒答时逐段回退、取消、一条 user 消息与 `<think>` 清理、术语进入批量提示词、假 fetch、重试阶梯、`mostly_untranslated`；`pipeline/stages/translate.test.ts`：缓存写失败只记一次、用户术语表、`glossary.csv`。

## 4.15 术语表（`babeldoc/glossary.ts`、`babeldoc/terms.ts`）

> 4.1.0 新增，照 BabelDOC `glossary.py` 与 `midend/automatic_term_extractor.py`（ADR-0018 §2）。

- **`Glossary`**：名称 + 条目 `{ source, target, targetLanguage? }`；按 `normalizeSource`（小写、连续空白合为一个空格、trim）去重，先出现的留下。`activeEntries(text)`：文本的连续空白换成一个空格后只折叠 ASCII 大小写，条目原文（同样只折叠 ASCII）是它的子串即命中（BabelDOC 用 hyperscan `HS_FLAG_CASELESS`，没开 UTF8/UCP）。
- **CSV**（`glossaryFromCsv`）：先按 UTF-8 解码（去掉 BOM），不是合法 UTF-8 时按 GB18030（代替 BabelDOC 的 chardet 猜测）；按 Python `csv` 默认方言解析；首行是表头，必须有 `source`、`target` 列（否则 `GlossaryFormatError`：`术语表 CSV 必须包含 source 和 target 两列`），可选 `tgt_lng`：非空且小写、`-` 换成 `_` 后不等于 `zh_cn` 的行跳过。`toCsv()`：表头 `source,target,tgt_lng`，CRLF 行尾，含 `"`、`,`、换行的字段加引号。
- **用户术语表**：设置 → 高级 →「术语表」导入（`glossaries:import`，05 §5.6），CSV 原样复制到 `<library>/glossaries/<id>.csv`，`settings.glossaries` 记 `GlossaryInfo = { id, name, enabled, entries }`（名称 = 文件名去掉 `.csv`，最多 100 个）。`documents:create` 把当时启用的 id 存进 manifest `options.glossaryIds`；翻译阶段（`loadUserGlossaries`）按这些 id 读文件，名称取设置里的（设置里已没有时用 id），文件已删除就跳过。
- **自动抽取**（`extractTerms`，照 `AutomaticTermExtractor`）：`translation.autoExtractGlossary` 开（默认）时在翻译前进行。逐页累积段落（跳过 cid、纯数字、只有占位符的段，不看 `minTextLength`），累计 token > 600 或段数 > 12 时成批，页末余下的也成一批；按 token 降序由 `perDocumentConcurrency` 个 worker 执行。提示词 `automatic_term_extractor.LLM_PROMPT_TEMPLATE`（`str.format` 语义）：目标语言 `zh-CN`，输入为该批段落文本以空行连接，用户术语表在其中命中的条目作为 `Reference Glossaries (for consistency and quality):` 附上。回复经 `_clean_json_output` 后 `JSON.parse`，不是数组就包成数组；每项取 `src`、`tgt`（Python `str()` 后 trim），两者相同且少于 3 个字符的跳过，两者非空且 `src` 少于 100 个字符的收下。一批出错（不结束文档的）就丢掉这批，结束事件的 detail 为 `K 批术语抽取失败，不影响翻译`。
- **合成**（`finalize_auto_extracted_glossary`）：同一原文取出现最多的译文（并列取先出现的），名为 `auto_extracted_glossary`（与用户术语表重名时加 `#1`、`#2`…）；一条都没有时为 null。事件 `抽取术语：N 条` / `抽取术语：没有得到术语`。
- **翻译时用哪些**（`get_glossaries_for_translation`）：开启自动抽取且得到了自动术语表 → 只用自动术语表（用户术语表只在抽取时作参考）；否则用用户术语表。每个请求只列出在本批（或本段）送翻译文本里命中的条目（4.9）。
- **检查点与输出**（`pipeline/stages/translate.ts`）：抽取完、翻译前写 `work/auto-glossary.json`（`{ fingerprint, name, entries }`，没有术语时 `name`、`entries` 为 null；指纹同 4.12），续跑时指纹一致就直接用，不再抽取。翻译完成且有自动术语表时写 `work/glossary.csv`（UTF-8 带 BOM，即 BabelDOC `save_auto_extracted_glossary` 的 `utf-8-sig`），归档时移到 `output/glossary.csv`，manifest `outputs.glossary` 记字节数，翻译完成事件末尾加 `，术语表 N 条`（05 §5.5）；文档详情的「导出」可另存（06 §6.4）。
