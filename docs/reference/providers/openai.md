# OpenAI

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 现役模型两大系列：GPT-6 系列（`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`，旗舰页主推）和 GPT-5.x 推理系列（文档中在用的有 `gpt-5.6`、`gpt-5.6-sol`（pro 模式）、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`）。全系为推理模型，官方明确「Reasoning models like GPT-5.5 use internal reasoning tokens before producing a response」，推理 token 按输出计费。[2][3][5]
- 只有国际站 platform.openai.com，没有国内站，也没有人民币计价。注册、充值需要海外支付方式；服务区域限制见使用政策，中国大陆不在支持区域内（风险见末节）。
- **没有 API 订阅套餐**。ChatGPT 的 Plus / Pro / Business（Standard seat $20/月、Premium seat $100/月）/ Enterprise 都是聊天产品席位，与 API 按量计费完全分开，Key 不通用。[6] 在 DocFlow 里只有「按量 API」一个预设。

## 接入方式

### 按量 API（platform.openai.com）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 按 token 计费，缓存命中输入约为输入价的 10%，缓存写入为 1.25 倍；Batch 与 Flex 为 5 折，Fast 模式 2 倍。[3] |
| Base URL | `https://api.openai.com/v1`，OpenAI 兼容格式 `POST /v1/chat/completions`、`GET /v1/models`。[7] |
| 鉴权方式 | `Authorization: Bearer ${OPENAI_API_KEY}`。[7] |
| Key 获取页 | https://platform.openai.com/api-keys [7] |
| 使用限制 | 服务协议与 Usage Policies 通用条款；未查到针对翻译类应用的专门限制条款。[8] |

价格（每百万 tokens）[2][3]：

| 模型 | 输入 | 缓存命中 | 输出 | 上下文 | 最大输出 |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-astra` | $10.00 | $1.00 | $50.00 | 1.05M | 128K |
| `gpt-6-sol` | $2.00 | $0.20 | $10.00 | 1.05M | 128K |
| `gpt-6-luna` | $0.10 | — | $0.50 | 1.05M | 128K |

- `gpt-6-sol` 页特别注明：输入超过 272K tokens 的请求，输入与缓存按 2 倍、输出按 1.5 倍计价（整个请求）。[3]
- 模型页为每个模型单独标价；GPT-5.x 系列价格未在本次抓取中完整获得，引用以各自模型页为准。[2]

### 订阅套餐

无 API 订阅套餐。ChatGPT 各档是聊天产品，不适用于 DocFlow。[6]

## 模型

| 模型 ID | 类型 | 上下文 | 最大输出 | temperature | 思考开关与强度 | 其他采样限制 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-astra` | 推理，模型页标注 effort 档 `low/medium/high/xhigh/max`（无 `none`） | 1.05M | 128K | API 默认 1；推理模型传非默认值报 400（社区实测，见风险提示） | Chat Completions 用 `reasoning_effort`；Responses API 用 `reasoning.effort` / `reasoning.mode` | 推理模型不支持 `top_p` / `presence_penalty` / `frequency_penalty` 等（Azure 文档口径，见末节） | [2][5][9] |
| `gpt-6-sol` | 推理，effort 档 `none/low/medium/high/xhigh/max` | 1.05M | 128K | 同上 | 同上；Responses API 支持 `standard`/`pro` 模式，pro 默认 effort 也是 medium | 同上 | [2][3][5] |
| `gpt-6-luna` | 推理，effort 档同 sol | 1.05M | 128K | 同上 | 同上 | 同上 | [2][5] |
| `gpt-5.5` / `gpt-5.6` 系列 | 推理；`gpt-5.6` 家族含 `gpt-5.6-sol`（pro 模式）、`gpt-5.6-terra`、`gpt-5.6-luna` | 各模型页为准 | 各模型页为准 | 同上 | effort 取值集合模型相关（`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 的子集）；`gpt-5.5` 默认 `medium`；`gpt-5.6` 省略时默认 `medium`（两种模式都是） | 同上 | [5] |

- `reasoning.effort` 官方档位说明原文摘录：none＝延迟敏感、无需推理的任务；low＝高效推理（数据分析、起草）；medium＝质量与可靠性优先的默认档（agentic coding、研究）；high＝复杂推理与调试；xhigh/max＃仅在评测证明值得时用。翻译不在示例场景中，属「起草/数据加工」类，介于 none 与 low 之间。[5]
- 推理 token 不可见但占用上下文、按输出计费；usage 的 `output_tokens_details.reasoning_tokens` 可见数量。官方建议为推理和输出预留至少 25,000 tokens 的余量。[5]
- **temperature**：官方 reasoning 指南未给出温度取值表；Chat Completions API 参考中 temperature 默认值为 1。社区实测 GPT-5 系模型对非默认温度返回 400「Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported」；第三方知识库称 GPT-5.1 起在 `reasoning_effort=none` 时支持温度（非官方口径，待核）。[9][10][11]

## 限流与档位

### 按量 API

- **组织层级**：限流定义在组织级和项目级，不是用户级；不同模型限流不同；长上下文请求（如 GPT-5.5 系列）有单独限流，在开发者后台查看。[1]
- **使用档位（官方表）**[1]：

  | 档位 | 资格 | 月度使用上限 |
  | --- | --- | --- |
  | Free | 位于允许的地理区域 | $100 / 月 |
  | Tier 1 | 已付费 $5 | $100 / 月 |
  | Tier 2 | 已付费 $50 | $500 / 月 |
  | Tier 3 | 已付费 $100 | $1,000 / 月 |
  | Tier 4 | 已付费 $250 | $5,000 / 月 |
  | Tier 5 | 已付费 $1,000 | $200,000 / 月 |

  随累计付费自动升档，限流随之提高。
- **每模型 RPM / TPM**：官方文档没有静态数值表，「To view a high-level summary of rate limits per model, visit the models page」，models 页按登录账号动态展示 → **未查到固定数值**。[1][2]
- **响应头**：`x-ratelimit-limit-requests`、`x-ratelimit-remaining-tokens`、`x-ratelimit-reset-requests/tokens`（还有 project 级）、429 临时限流与 503 过载时可能带 `Retry-After`（秒）。[1]
- **超限返回**：429 + `rate_limit_error` + `slow_down`（流量上升过快，注意： RPM/TPM 没打满也可能触发）；503 + `service_unavailable_error` + `server_is_overloaded`（模型临时过载）。爬坡经验值：达到 1M TPM 后每 15 分钟增幅不超过 50%。[1]
- **企业选项**：Scale Tier（按量保障容量）与（GPT-5.6 起的）Reserved Tier；服务档 `service_tier` 有 `default`/`flex`（5 折）/`priority`/`scale`。[1][3]

### 订阅套餐

无（见前文）。[6]

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | OpenAI | — |
| Base URL（按量） | `https://api.openai.com/v1`，与规划 4.2 一致，无需改 | [7] |
| Base URL（套餐） | 无 | [6] |
| Key 获取页 | https://platform.openai.com/api-keys | [7] |
| 新账号安全并发数 | **20**。新账号在低档（Free~Tier 1，月上限 $100），每模型 RPM/TPM 未公开，20 并发足以打满低档限速又不至于频繁 429；配合 DocFlow 自适应升回。 | [1] |
| 翻译请求构造 | `reasoning_effort: "none"` 写进服务商级 `extraBody`（GPT-6 Sol/Luna 支持 none；Astra 不支持，用户若选 Astra 需自行接受推理开销）。**不传 temperature**。 | [2][5][9] |
| 首选翻译模型 | **`gpt-6-luna`**（$0.1/$0.5，成本最低、延迟最低，effort=none 适合翻译）；预算充足可用 `gpt-6-sol`。 | [2][5] |
| max_tokens | 不设置（模型默认 128K 上限内自适应）；推理模型会预留推理 token，遇到截断再调大 | [5] |

风险提示：

1. **temperature 兼容性**：推理模型对非默认温度报 400（`unsupported_value`），DocFlow 若按 DeepSeek 的习惯给 OpenAI 预设塞温度会导致整批失败。在官方给出明确说明前，OpenAI 预设走「不传温度 + effort=none」路线。[9][10]
2. **地理限制**：OpenAI 不支持中国大陆等区域，用户需要海外网络环境与支付方式；403 可能是区域限制而非 Key 失效（DocFlow 的错误分类已按正文区分 403，见 4.3）。[8]
3. **推理 token 计费**：不显式关思考时，每个翻译段都会先烧推理 token，成本数倍上升且变慢；`finish_reason=length` 也可能是推理挤占了输出预算。[5]
4. **Chat Completions 是二等公民**：官方明确推理模型「work better with the Responses API」，Chat Completions 仍受支持但智能与性能略差；DocFlow 的 OpenAI 预设基于 Chat Completions，属可接受折衷。[5]
5. **模型换代极快**：GPT-6 系列刚上线、GPT-5.x 仍在文档中，模型名与价位可能短期变化；预设不写死模型 ID（维持现状）。[2][5]

## 来源

1. [Rate limits（OpenAI Platform Docs）](https://platform.openai.com/docs/guides/rate-limits)（2026-09-23 访问）
2. [Models（OpenAI Platform Docs）](https://platform.openai.com/docs/models)（2026-09-23 访问）
3. [gpt-6-sol 模型页](https://platform.openai.com/docs/models/gpt-6-sol)（2026-09-23 访问）
4. [Chat Completions API 参考](https://platform.openai.com/docs/api-reference/chat/create)（2026-09-23 访问）
5. [Reasoning 指南](https://platform.openai.com/docs/guides/reasoning)（2026-09-23 访问）
6. [OpenAI 定价页（ChatGPT 席位）](https://openai.com/api/pricing/)（2026-09-23 访问）
7. [OpenAI API keys 页](https://platform.openai.com/api-keys)（2026-09-23 访问）
8. [Usage policies](https://openai.com/policies/usage-policies/)（2026-09-23 访问）
9. [Azure OpenAI reasoning models（参数支持口径）](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)（2026-09-23 访问）
10. [GPT-5 models - Temperature（OpenAI 社区，非官方）](https://community.openai.com/t/gpt-5-models-temperature/1337957)（2026-09-23 访问）
11. [Temperature parameter not supported in GPT-5 models（Braintrust KB，非官方）](https://www.braintrust.dev/docs/kb/temperature-parameter-not-supported-in-gpt)（2026-09-23 访问）
