# OpenRouter

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 定位：统一网关，一个 Key 调所有主流模型，原价转售（「passes through the pricing of the underlying providers without any markup」）+ 统一计费 + 供应商故障转移。模型 ID 带厂商前缀（如 `openai/gpt-6-luna`、`deepseek/deepseek-flash`），支持 `:free`、`:batch` 变体和 `openrouter/auto` 自动路由。[1][2]
- 只有国际站 openrouter.ai，无国内站。
- **没有订阅套餐**：预充值 Credits（$ 额度），按量扣费；Enterprise 可走对公发票。另有 BYOK（自带上游厂商 Key），超出免费额度后按 list price 的一定比例收平台费（比例以定价页为准，文档中数值未直接给出）。[1][3]

## 接入方式

### 按量 API（openrouter.ai）

| 项目       | 内容                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 计费方式   | 预充值 Credits，按上游原价扣费，无加价；充值收平台费（加密币另计）；余额不足回 402。Key 可单独设消费上限（onboarding 送的 Key 默认 $100 上限、180 天过期）。[1][3] |
| Base URL   | `https://openrouter.ai/api/v1`，OpenAI 兼容 `POST /api/v1/chat/completions`、`GET /api/v1/models`。`GET /api/v1/key` 查余额与限额。[2][3]                          |
| 鉴权方式   | `Authorization: Bearer ${OPENROUTER_API_KEY}`。[4]                                                                                                                 |
| Key 获取页 | https://openrouter.ai/keys [4]                                                                                                                                     |
| 使用限制   | 服务条款通用；未查到针对翻译类应用的专门限制。[1]                                                                                                                  |

### 订阅套餐

无 Credits 之外的套餐；BYOK 是能力不是套餐（见概览）。[1][3]

## 模型

- 模型由上游决定：OpenRouter 自己不定义温度/思考语义，请求参数**原样转发**给上游。「If the chosen model doesn't support a request parameter (such as `logit_bias` in non-OpenAI models, or `top_k` for OpenAI), then the parameter is ignored. The rest are forwarded to the underlying model API.」[2]
- `temperature` 平台口径范围 [0, 2]；思考类参数（如 `reasoning_effort`、`thinking`）按 OpenAI 接口原样透传，能否生效取决于命中的上游与模型。[2]
- 变体：`:free`（免费版，独立限流）、`:batch`（Batch API 半价）；路由：`openrouter/auto`（按 `cost_tier` low~max 选模型）、`models: [...]` 回退链、`provider` 偏好排序。[2][5]

## 限流与档位

### 按量 API

- **全局限额**：「Making additional accounts or API keys will not affect your rate limits, as we govern capacity globally.」——限流跟账号走，多 Key 无用。[3]
- **两类限额**（官方表）[3]：

  | 限额类型      | 管什么                                 | 报错                                                                             | 查询                                  |
  | ------------- | -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
  | Credit limits | 余额、Key 消费上限、in-flight 花费预算 | 402（`error.metadata.limit_source` 区分三种来源）                                | `GET /api/v1/key` → `limit_remaining` |
  | Rate limits   | 请求频率（免费模型上限 + DDoS 防护）   | 429（带 `X-RateLimit-*` 头；上游限流时 `error.metadata.provider_code` 带上游码） | `GET /api/v1/key` / 错误响应头        |

- **免费模型变体（`:free`）限额**（官方表）：累计充值 <10 credits → 20 RPM / 50 次每天；≥10 credits → 20 RPM / 1,000 次每天。[3]
- **付费模型**：平台层不设请求数上限，实际瓶颈是上游供应商的限流与「in-flight spending budget」（低余额/新账号的在途花费上限）。429 会自动 fallback 到其他供应商重试后才返回。[3]
- **响应细节**：成功响应不带 `X-RateLimit-*`；429 时带 `X-RateLimit-Limit/Remaining/Reset`，所有上游都给了重试提示时还有 `Retry-After`。[3]

### 订阅套餐

无（见前文）。

## 对 DocFlow 的建议

| 项               | 建议                                                                                                                                                                        | 依据          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 显示名           | OpenRouter                                                                                                                                                                  | 规划 4.2 已定 |
| Base URL         | `https://openrouter.ai/api/v1`（规划一致）                                                                                                                                  | [2]           |
| Key 获取页       | https://openrouter.ai/keys                                                                                                                                                  | [4]           |
| 新账号安全并发数 | **20**。平台层不限付费模型请求数，但 in-flight 预算会卡低余额新账号，20 并发配合 429 自适应合适；余额充足后可调高。                                                         | [3]           |
| 翻译请求构造     | 温度随上游而定，**最稳妥是不传温度**（免费/低价上游多为推理模型，传非默认值会被上游 400）；不要用服务商级 extraBody 一刀切思考参数（不同上游语义冲突，同 groq.md 的教训）。 | [2]           |
| 首选翻译模型     | 不写死：按 `openrouter/auto`（cost_tier 选 low~medium）或用户自选；若要点名，选**非推理**的便宜模型（上游列表随市场变动，改预设时查 models 页）。                           | [2][5]        |
| 额外机会         | `models: ["a","b"]` 回退链可平替 DocFlow 的多服务商轮换；`provider.sort: "price"` 可强制低价优先。属于后续增强，不属于 4.0 预设范围。                                       | [2][6]        |

风险提示：

1. **参数透传双刃剑**：OpenRouter 会忽略上游不认识的参数，但上游认识且拒绝的（GPT-5 系拒绝非默认 temperature）照样 400——错误来自上游而非 OpenRouter，DocFlow 按正文分类时会看到上游原文。[2][3]
2. **402 ≠ Key 失效**：余额、Key 上限、in-flight 预算三种来源都回 402，`limit_source` 能区分；DocFlow 的错误文案建议提示用户「充值或提高 Key 限额」。免费模型余额为负也会 402。[3]
3. **免费变体不适合翻译**：50~1,000 次/天、20 RPM，翻译一篇论文就超限；且免费上游队列长、不稳定。[3]
4. **隐私**：请求经过第三方网关，论文类未公开稿件有泄露面；OpenRouter 提供数据收集开关（具体默认值未查到，建议用户自行确认设置）。敏感文档优先直连厂商。[1]
5. **型号命名**：模型 ID 带厂商前缀且随上游生灭，预设不写死模型（维持现状）。[2]

## 来源

1. [OpenRouter FAQ](https://openrouter.ai/docs/faq)（2026-09-23 访问）
2. [API Reference - Requests](https://openrouter.ai/docs/api_reference/overview)（2026-09-23 访问）
3. [API Credit & Rate Limits](https://openrouter.ai/docs/api_reference/limits)（2026-09-23 访问）
4. [API Authentication](https://openrouter.ai/docs/api_reference/authentication)（2026-09-23 访问）
5. [Auto Router](https://openrouter.ai/docs/features/model-routing)（2026-09-23 访问）
6. [How OpenRouter Model Routing Works（官方博客）](https://openrouter.ai/blog/insights/model-routing/)（2026-09-23 访问）
