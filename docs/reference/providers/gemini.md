# Google Gemini

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 现役模型家族（官方模型页 / 迁移文档）：Gemini 3 系（`gemini-3-pro-preview`：1M 输入、64K 输出、知识截止 2025-01；`gemini-3.1-flash`、`gemini-3.1-flash-live-preview`：输入 131,072 起）与 Gemini 2.5 系（`gemini-2.5-flash`、`gemini-2.5-flash-lite`，2.5 Pro 访问受限「we are limiting access to the 2.5 models」）。Gemini 3 的思考参数为 `thinking_level`（旧 `thinking_budget` 仍兼容但建议迁移，两者不要同请求使用）。[1][2][3]
- 只有国际平台（Google AI Studio / ai.google.dev），无国内站；另一路径是 Vertex AI（配额体系独立，DocFlow 预设走 AI Studio）。
- **没有 API 订阅套餐**。Google AI Pro / Ultra 是消费者聊天产品；API 侧「付费」= 给 AI Studio 项目关联 GCP 计费账号，立即升为 Tier 1，按量计费。[4][5]

## 接入方式

### 按量 API（Google AI Studio）

| 项目       | 内容                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式   | 按 token 计费；Batch API 5 折；Context Caching 按缓存 token 低价计；Search Grounding 每月 5,000 次免费后 $14/千次。Free tier 免费但**数据会被用于改进 Google 产品**，付费档不受此条款。[3][4] |
| Base URL   | `https://generativelanguage.googleapis.com`，Gemini 格式 `POST /v1beta/models/{model}:generateContent`、`GET /v1beta/models`。[1][6]                                                          |
| 鉴权方式   | `x-goog-api-key: ${GEMINI_API_KEY}`（DocFlow 规划 4.3 已定）。[6]                                                                                                                             |
| Key 获取页 | https://aistudio.google.com/apikey [6]                                                                                                                                                        |
| 使用限制   | 未查到针对翻译类应用的专门限制；Free tier 有可用区域限制。付费档「数据不用于训练」，适合处理用户文档。[4]                                                                                     |

价格：定价页按模型列出（含免费档开关）；本次未能完整抓取每个模型的现价，引用时以 [3] 为准 → 各模型具体价格**未查到完整数值**，改预设前需人工核对定价页。

### 订阅套餐

无（Google AI Pro/Ultra 是聊天产品）。[4]

## 模型

| 模型 ID                                      | 类型                           | 上下文 | 最大输出 | temperature                                                                                             | 思考开关                                                                                       | 来源   |
| -------------------------------------------- | ------------------------------ | ------ | -------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| `gemini-3-pro-preview`                       | 思考默认开（`thinking_level`） | 1M     | 64K      | 官方迁移建议：**移除显式 temperature，用默认值 1.0**（低温度在 Gemini 3 上可能导致 looping / 性能下降） | `thinking_level: "high"` 简化提示词；`thinking_budget` 兼容但不建议同用                        | [1][2] |
| `gemini-3.1-flash`                           | 快速版，思考可配               | ≥131K  | 未查到   | 同上                                                                                                    | 同上                                                                                           | [2][3] |
| `gemini-2.5-flash` / `gemini-2.5-flash-lite` | 上一代主力                     | 1M     | 64K      | 默认 1.0                                                                                                | `thinkingConfig: {"thinkingBudget": 0}` 关闭思考（DocFlow 规划 4.3 的 extraBody 示例就是这个） | [1][6] |

- 官方迁移文档原文要点：「If your existing code explicitly sets temperature (especially to low values for deterministic outputs), we recommend removing this parameter and using the Gemini 3 default of 1.0」；「try Gemini 3 with `thinking_level: "high"` and simplified prompts」。[1]

## 限流与档位

### 按量 API

- **档位阶梯**（官方 rate-limits 页口径）：Free（活跃项目即可）→ Tier 1（关联 GCP 计费账号即升，无最低消费）→ Tier 2（累计付费 $250 且首次付款满 3 天）→ Tier 3（累计 $1,000 且满 30 天）。月消费上限随档位提高（Tier 1 约 $250）。[5]
- **每模型 RPM/TPM/RPD**：官方页只给阶梯说明，精确数值**按账号在 AI Studio > Dashboard > Rate Limit 查看**（论坛官方答复原话），第三方整理的典型值：2.5 Flash Free 10 RPM / Tier 1 1,000 RPM；2.5 Pro Free 5 RPM·100 RPD / Tier 1 150 RPM·10,000 RPD；`gemini-3-pro-preview` Tier 1 为 25 RPM·250 RPD（论坛用户实测，2025-12）。**数值随 Google 调整变动，以上均为参考，以账号实时页为准。**[5][7]
- **超限返回**：HTTP 429 + `status: RESOURCE_EXHAUSTED` + `message: "Resource has been exhausted (e.g. check quota)."`；免费档错误正文常见「Quota exceeded for metric: ...generate_content_free_tier_requests」。[7]
- **限额归项目不归 Key**：同一项目下的多个 Key 共享配额。[5]

### 订阅套餐

无（见前文）。

## 对 DocFlow 的建议

| 项               | 建议                                                                                                                                                                      | 依据          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 显示名           | Google Gemini                                                                                                                                                             | 规划 4.2 已定 |
| Base URL         | `https://generativelanguage.googleapis.com`（规划一致）                                                                                                                   | [6]           |
| Key 获取页       | https://aistudio.google.com/apikey                                                                                                                                        | [6]           |
| 新账号安全并发数 | **3**（免费档 10 RPM 量级，并发 3 已能打满）；关联计费升 Tier 1 后可调到 20                                                                                               | [5][7]        |
| 翻译请求构造     | **不传 temperature**（Gemini 3 官方建议移除）；用 `thinkingConfig.thinkingBudget: 0` 尝试关闭思考（2.5 系确定有效；3.x 若忽略该参数也无害——extraBody 深合并已兼容此写法） | [1][6]        |
| 首选翻译模型     | **`gemini-3.1-flash`**（速度与质量平衡）；低成本大批量用 `gemini-3.1-flash-lite` / `gemini-2.5-flash-lite`                                                                | [2][3]        |
| maxOutputTokens  | 不设置（默认到模型上限内自适应）；3 Pro 上限 64K                                                                                                                          | [2]           |

风险提示：

1. **Free tier 数据条款**：免费档输入会被 Google 用于训练；翻译用户文档（论文、未公开稿件）应提示改用付费档。[4]
2. **温度陷阱**：给 Gemini 3 传低温度（如翻译惯用的 0.3）可能触发 looping 或性能下降，这是 DocFlow「每服务商温度」设计里最需要按厂商区分的点。[1]
3. **限额不透明且频繁调整**：2025 年底曾出现 Tier 1 被错误按免费档限额的故障（论坛大量报告）；DocFlow 的 429 自适应降并发是必需兜底。[7]
4. **RPD 是隐藏天花板**：长文档批量翻译容易先撞每日请求数（Pro 系尤其紧），表现为「用量没满却被限」。[5][7]
5. **区域限制**：AI Studio 在部分区域不可用，需可访问 Google 服务的网络环境。

## 来源

1. [Migrating from Gemini 2.5（Google AI Developers 官方论坛置顶）](https://discuss.ai.google.dev/t/i-think-im-banned-but-no-message-from-google-ai-studio-down-for-6-hours-now-i-thought-it-was-my-video-that-killed-it-but-permission-denied/110086)（2026-09-23 访问；迁移指南部分）
2. [Models | Gemini API](https://ai.google.dev/gemini-api/docs/models)（2026-09-23 访问）
3. [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)（2026-09-23 访问）
4. [Billing | Gemini API](https://ai.google.dev/gemini-api/docs/billing)（2026-09-23 访问）
5. [Rate limits | Gemini API](https://ai.google.dev/gemini-api/docs/rate-limits)（2026-09-23 访问；直连抓取失败，经官方论坛与二手整理交叉核对）
6. [Gemini API 参考（generateContent / 鉴权）](https://ai.google.dev/api/generate-content)（2026-09-23 访问）
7. [Google AI Developers Forum：Tier 1 限额相关讨论](https://discuss.ai.google.dev/t/rate-limit-for-gemini-3-pro-preview/110621)（2026-09-23 访问）
