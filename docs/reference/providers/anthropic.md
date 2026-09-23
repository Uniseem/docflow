# Anthropic（Claude）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 现役对话模型（官方模型总览页）：`claude-fable-5.1`、`claude-fable-5`（限量版的 Mythos 同价）、`claude-opus-5.5`、`claude-opus-5`、`claude-opus-4.8`/`4.7`/`4.6`/`4.5`、`claude-sonnet-5`、`claude-sonnet-4.6`/`4.5`、`claude-haiku-4.5`（`claude-haiku-3.5` 等旧款已退役，仅在 Bedrock / Google Cloud 提供）。全系支持文本+图像输入、文本输出。[1][2]
- 只有一个平台（国际站 console.anthropic.com / docs 称 Claude Platform），无国内站，人民币计价无。
- **没有 API 订阅套餐**。Claude Pro / Max / Team / Enterprise 是 Claude.ai 聊天产品订阅，与 API 按量计费分开。API 按组织层级计费，另有 Batch API（5 折）与 Priority Tier（承诺容量，输入按 1.1~2 倍系数计量）。[2][6]

## 接入方式

### 按量 API（Claude Platform）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 按 token 计费；缓存写（5 分钟 1.25 倍、1 小时 2 倍）与缓存读（命中 0.1~0.25 倍）另计；Batch 5 折；Fast 模式（Opus 5.5 / Opus 5 / Opus 4.8，2 倍价）；Priority Tier 按容量承诺计价。[2] |
| Base URL | `https://api.anthropic.com`，Messages API 为 `POST /v1/messages`，模型列表 `GET /v1/models`。[4] |
| 鉴权方式 | `x-api-key: ${ANTHROPIC_API_KEY}` + `anthropic-version: 2023-06-01`。[4] |
| Key 获取页 | https://console.anthropic.com/settings/keys [4] |
| 使用限制 | 商用允许（服务条款面向开发者应用）；有 Usage Policy 通用条款，未查到针对翻译类应用的专门限制。[5] |

价格（每百万 tokens，输入 / 输出）[2]：

| 模型 | 输入 | 缓存写 5m | 缓存写 1h | 缓存读 | 输出 |
| --- | --- | --- | --- | --- | --- |
| `claude-fable-5.1` / `claude-fable-5` | $10.00 | $12.50 | $20.00 | $0.25 / $1.00 | $50.00 |
| `claude-opus-5.5` | $4.00 | $5.00 | $8.00 | $0.20 | $20.00 |
| `claude-opus-5` / `claude-opus-4.8` | $5.00 | $6.25 | $10.00 | $0.50 | $25.00 |
| `claude-sonnet-5` | $2.00 | $2.50 | $4.00 | $0.20 | $10.00 |
| `claude-sonnet-4.6` / `4.5` | $3.00 | $3.75 | $6.00 | $0.30 | $15.00 |
| `claude-haiku-4.5` | $1.00 | $1.25 | $2.00 | $0.10 | $5.00 |

### 订阅套餐

无 API 订阅套餐（Claude.ai 套餐不适用，见概览）。[2][6]

## 模型

| 模型 ID | 类型 | 上下文 | 最大输出 | temperature | 思考 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-fable-5.1` | 混合，思考 Adaptive（常开），默认 effort `high` | 1M | 128K | 见下 | 不可关（Adaptive always on） | [1] |
| `claude-opus-5.5` | 同上，默认 effort `high`；支持 Fast 模式 | 1M | 128K | 见下 | 同上 | [1][2] |
| `claude-opus-5` / `claude-sonnet-5` | 同上 | 1M | 128K | 见下 | 同上 | [1] |
| `claude-haiku-4.5` | 最快档；「Thinking: Extended」 | 200K | 64K | 见下 | 官方页未给开关细节 | [1] |

- **temperature**：官方 API 参考原文：「Amount of randomness injected into the response. Defaults to 1.0. Ranges from 0.0 to 1.0. Use temperature closer to 0.0 for analytical / multiple choice, and closer to 1.0 for creative and generative tasks. Note that even with temperature of 0.0, the results will not be fully deterministic.」官方同时建议只动 temperature、不要同时改 top_p。[4]
- **新款模型的弃用情况（非官方渠道，需实测确认）**：社区与第三方库报告 `claude-opus-4.7` 起对 temperature 整个弃用（传值报 400「`temperature` is deprecated for this model」），Opus 4.6 之后的模型 top_p 弃用（<0.99 报 400）；`claude-sonnet-5` 的思考类型默认为 `adaptive`。截至查证日官方文档尚未把这些写入参数页，DocFlow 应**默认不发送 temperature**。[7][8]
- **思考参数**：`thinking: {"type": "enabled"/"adaptive"/"disabled", "budget_tokens": N}`；`budget_tokens` 需 ≥1024 且小于 `max_tokens`（官方旧口径）；新集成官方引导用 `output_config.effort`（`low`/`medium`/`high`）。Fable / Opus / Sonnet 5 系思考为 Adaptive 常开，关掉的空间有限。[1][7][8]

## 限流与档位

### 按量 API

- **档位**：组织自动分档（Console 的 Rate limits 页可见自己档位）。新组织可能先在 **Evaluation 档**（低于下表的标准限值，随使用历史自动提升）；标准档分 Start / Build / Scale 三档，Scale 以上可联系销售。[2][3]
- **标准限值（按模型，官方表）**[3]：

  | 模型 | RPM | ITPM（不计缓存读） | OTPM |
  | --- | --- | --- | --- |
  | `claude-fable-5.x` | 1,000 | 500,000 | 100,000 |
  | `claude-opus-5` / `claude-opus-4.x` | 1,000 | 2,000,000 | 400,000 |
  | `claude-sonnet-5` / `claude-sonnet-4.x` | 1,000 | 2,000,000 | 400,000 |
  | `claude-haiku-4.5` | 1,000 | 2,000,000 | 400,000 |
  | `claude-haiku-3.5`（退役） | 1,000 | 100,000 | 20,000 |

  限流按模型分别计算，可同时打满多个模型；ITPM 不计缓存读，实际吞吐可远高于表面值。
- **响应头**：`retry-after`（秒）、`anthropic-ratelimit-requests-limit/remaining/reset`、`anthropic-ratelimit-input-tokens-*`、`anthropic-ratelimit-output-tokens-*`（RFC 3339 reset 时间）；Priority Tier 另有 `anthropic-priority-*` 头。spend cap 触发的 429 不带 `retry-after`。[3]
- **令牌桶**：限流是连续补充的令牌桶，不是固定窗口重置；60 RPM 可能按 1 RPS 平滑执行。[3]

### 订阅套餐

无（见前文）。

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- | --- |
| 显示名 | Anthropic（Claude） | 规划 4.2 已定 |
| Base URL | `https://api.anthropic.com`（规划 4.2 一致，请求拼 `/v1/messages`） | [4] |
| Key 获取页 | https://console.anthropic.com/settings/keys | [4] |
| 新账号安全并发数 | **10**。新组织可能落在 Evaluation 档（限值低于标准表且未公开），10 并发配合 429 自适应足够；标准档 1000 RPM 的容量远超 DocFlow 需求。 | [3] |
| 翻译请求构造 | **不传 temperature、不传 top_p**（新款模型可能 400）；不要尝试关思考（5 系 Adaptive 常开）。`max_tokens` 维持 DocFlow 默认 8192 即可。 | [4][7][8] |
| 首选翻译模型 | **`claude-haiku-4.5`**（$1/$5，200K 上下文、64K 输出，速度最快）；长段落/高质量需求用 `claude-sonnet-5`。 | [1][2] |
| 思考开销 | 5 系默认 effort `high`，翻译场景偏大；官方提供 `output_config.effort` 降档，但 DocFlow 的 anthropic 请求体暂未预留该字段——建议先在服务商级 extraBody 里试 `{"output_config":{"effort":"low"}}`，实测通过后再固化（新模型若不接受会 400，需要回退）。 | [1][8] |

风险提示：

1. **参数弃用 moving target**：Opus 4.7 起 temperature 弃用、4.6 后 top_p 弃用是社区/第三方库口径，官方参数页仍写 0–1 默认 1.0；不同模型行为可能不同，DocFlow 最稳妥就是「这两个参数对 Anthropic 一概不发」。[4][7][8]
2. **思考常开**：Fable/Opus/Sonnet 5 系 Adaptive 思考常开，翻译也要为推理 token 付费；Haiku 4.5 开销小但仍可能产生 thinking block（响应 content 里 `type: "thinking"` 块，解析时只取 text 块即可）。DocFlow 的响应解析需容忍 content 数组含 thinking 块。[1]
3. **Evaluation 档**：新组织限值低于公开标准表且数值未公开，429 频繁不等于配置错误；Console Rate limits 页可查实际档位。[3]
4. **区域限制**：Anthropic 不支持中国大陆等地区，需要海外网络与支付方式；403 不一定是 Key 失效。[5]
5. **max_tokens 是必填**：Messages API 的 `max_tokens` 为必填参数，DocFlow 已默认 8192，保持。[4]

## 来源

1. [Models overview - Claude Platform Docs](https://docs.anthropic.com/en/docs/about-claude/models/overview)（2026-09-23 访问）
2. [Pricing - Claude Platform Docs](https://docs.anthropic.com/en/docs/about-claude/pricing)（2026-09-23 访问）
3. [Rate limits - Claude Platform Docs](https://docs.anthropic.com/en/api/rate-limits)（2026-09-23 访问）
4. [Messages API 参考](https://docs.anthropic.com/en/api/messages)（2026-09-23 访问）
5. [Usage policies / 支持区域](https://www.anthropic.com/supported-countries)（2026-09-23 访问）
6. [Service tiers - Claude Platform Docs](https://docs.anthropic.com/en/api/service-tiers)（2026-09-23 访问）
7. [nanobot issue #3417：opus-4.7 拒收 temperature（非官方）](https://github.com/HKUDS/nanobot/issues/3417)（2026-09-23 访问）
8. [Spring AI Anthropic Chat 文档：参数弃用与 effort（非官方）](https://docs.spring.io/spring-ai/reference/api/chat/anthropic-chat.html)（2026-09-23 访问）
