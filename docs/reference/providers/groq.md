# Groq（Groq）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- GroqCloud 用自研 LPU 托管开源模型，主打速度（官方标称 gpt-oss-20b 约 1000 tps、gpt-oss-120b 约 500 tps），接口与 OpenAI 基本兼容。[1][4]
- **2026 年在售模型大幅收缩**，老教程里的模型名多数已不能用（Free / Developer 账号）[14]：
  - `llama-3.1-8b-instant`、`llama-3.3-70b-versatile`：2026-08-16 对 Free / Developer 下线，只有签了承诺消费合同的企业客户保留；模型页现在标为 Enterprise、价格「Contact Sales」。[1][10][11][14]
  - `qwen/qwen3-32b`、`meta-llama/llama-4-scout-17b-16e-instruct`：2026-07-17 下线。[14]
  - `qwen/qwen3.6-27b`：2026-09-14 下线，由 `qwen/qwen3.8-27b` 接替。[14]
  - `groq/compound`、`groq/compound-mini`：2026-09-21 下线，无替代。[14]
  - 更早下线的还有 `moonshotai/kimi-k2-instruct-0905`（2026-04-15）、`meta-llama/llama-4-maverick-17b-128e-instruct`（2026-03-09）、`gemma2-9b-it`（2025-10-08）等。[14]
- 结果：Free / Developer 账号现在能用的**通用文本模型只有三个**——`openai/gpt-oss-120b`、`openai/gpt-oss-20b`（Production）和 `qwen/qwen3.8-27b`（Preview）。[1][2]
- **没有订阅套餐**。只有 Free（免费、低限流）→ Developer（按量后付费）→ Enterprise（联系销售）三档，没查到任何月费套餐。[2][15]
- 注意：API 参考里 `model` 字段的枚举还列着 `compound-beta`、`gemma2-9b-it`、`qwen/qwen3-32b` 等已下线的名字，不能拿它当在售清单；以 `GET https://api.groq.com/openai/v1/models` 或模型页为准。[1][3]

## 接入方式

### 按量 API（Developer 计划）

| 项目                 | 内容                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式             | 按 token 后付费。升级时不立即扣款；新用户按累计用量 $1、$10、$100、$500、$1,000 五个阈值即时出账扣款，累计过 $1,000 后改为纯月结（印度账单地址为 $1、$10、之后每 $100）。不足 $0.50 不扣款。[15]                                                                            |
| 折扣                 | Batch API 五折（24 小时到 7 天的处理窗口，不占同步限流）[18]；Prompt caching 命中部分五折，仅 gpt-oss 系列支持，与 Batch 折扣不叠加 [18][19]                                                                                                                                 |
| OpenAI 兼容 Base URL | `https://api.groq.com/openai/v1` [4]                                                                                                                                                                                                                                         |
| 鉴权方式             | `Authorization: Bearer <GROQ_API_KEY>` [3][4]                                                                                                                                                                                                                                |
| Key 获取页           | https://console.groq.com/keys [4]                                                                                                                                                                                                                                            |
| 升级条件             | 从 Free 升到 Developer 需要绑定付款方式（信用卡、美国银行账户或 SEPA 借记账户），升级立即生效；可随时降回 Free，降级前要结清未出账用量。[15]                                                                                                                                 |
| 使用限制             | 限流按**组织**计，不按用户或 Key 计。Developer 额外可用 Flex 档（`service_tier: "flex"`，限额是按需档的 10 倍、同价，容量不足时快速失败返回 **498** `capacity_exceeded`）、Batch、Spend Limits。`service_tier` 不传时为 `on_demand`；`performance` 档只对企业开放。[2][16][17] |

价格（每百万 tokens，输入 / 输出）[1][6][7][8]：

| 模型                           | 输入   | 缓存输入 | 输出  |
| ------------------------------ | ------ | -------- | ----- |
| `openai/gpt-oss-120b`          | $0.15  | $0.075   | $0.60 |
| `openai/gpt-oss-20b`           | $0.075 | $0.037   | $0.30 |
| `qwen/qwen3.8-27b`（Preview）  | $0.80  | 未列出   | $4.00 |
| `openai/gpt-oss-safeguard-20b` | $0.075 | $0.037   | $0.30 |

### 免费（Free 计划）

| 项目                 | 内容                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| 计费方式             | 免费。                                                                                                 |
| OpenAI 兼容 Base URL | 同上 `https://api.groq.com/openai/v1`                                                                  |
| 鉴权方式             | 同上                                                                                                   |
| Key 获取页           | https://console.groq.com/keys                                                                          |
| 使用限制             | 每个模型单独的 RPM / RPD / TPM / TPD 低额度（见下文「限流与档位」）；不能用 Flex 和 Batch。[2][15][16] |

### 订阅

无。官方只有 Free / Developer / Enterprise 三档计划，没有月费套餐。[2][15]

### Enterprise

联系销售。Llama 3.x 两个模型和 `minimaxai/minimax-m2.7` 只对企业开放；更高限额和 `performance` 服务档也在这一档。[1][9][17]

## 模型

「temperature 范围 / 默认值」来自 API 参考（`temperature` 取 0–2，默认 1）；兼容说明补充：传 0 会被改成 `1e-8`，出问题时改用 `> 0` 且 `<= 2` 的 float32。[3][4]

| 模型 ID                                | 类型                                                                    | 上下文  | 最大输出 | temperature 范围 | 默认值 | 官方推荐值                                                                                                                                                                                                             | 思考/推理参数                                                                                                                                                                                                                                                          | 其他采样限制                                                                                                                                         | 来源               |
| -------------------------------------- | ----------------------------------------------------------------------- | ------- | -------- | ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `openai/gpt-oss-120b`                  | 文本，推理模型，Production                                              | 131,072 | 65,536   | 0–2              | 1      | OpenAI 官方：`temperature=1.0`、`top_p=1.0` [21]。Groq 推理文档的通用表给 0.6、建议区间 0.5–0.7（「防止重复或不连贯」），示例用 0.6 / top_p 0.95 [5]——两处说法不一致                                                  | `reasoning_effort`：`low` / `medium` / `high`，默认 `medium`，**不能关闭思考**；不支持 `reasoning_format`；推理默认放在 `message.reasoning` 字段，`include_reasoning: false` 可不返回 [3][5]                                                                           | `top_p` 0–1，默认 1。`frequency_penalty` / `presence_penalty` / `logit_bias` / `logprobs` / `top_logprobs` 标注「暂无模型支持」，其中后三者传了直接 400；`n` 只能为 1；`messages[].name` 会 400 [3][4] | [1][3][5][6][21]   |
| `openai/gpt-oss-20b`                   | 文本，推理模型，Production                                              | 131,072 | 65,536   | 0–2              | 1      | 同上                                                                                                                                                                                                                   | 同上                                                                                                                                                                                                                                                                   | 同上                                                                                                                                                 | [1][3][5][7][21]   |
| `qwen/qwen3.8-27b`                     | 文本 + 图像输入（每张图按 2048 输入 token 计，最多 3 张），Preview      | 131,042 | 16,384   | 0–2              | 1      | 非思考（Instruct）：`temperature=0.7`、`top_p=0.80`、`top_k=20`、`min_p=0`、`presence_penalty=1.5`；思考：`temperature=1.0`、`top_p=0.95`、`top_k=20`、`min_p=0`（Groq 模型页与 Qwen 模型卡一致）[8][22]               | `reasoning_effort`：`none` / `default` / `low` / `medium` / `high`（`high` 对应模型原生 `xhigh`）。API 参考说默认 `none`；推理文档说 `default` 在 Groq 上不返回推理 token；模型页又说思考模式用 `default`——三处不一致，建议显式传。`reasoning_format`：`raw`（`<think>` 放正文）/ `parsed` / `hidden` [3][5][8] | API 参考不含 `top_k`、`min_p`；`presence_penalty` 标注「暂无模型支持」，所以官方非思考推荐的 `presence_penalty=1.5` 按文档在 Groq 上用不了 [3]                                   | [1][3][5][8][22]   |
| `openai/gpt-oss-safeguard-20b`         | 安全分类（按自定义策略做内容审核），Preview，**不适合翻译**             | 131,072 | 65,536   | 0–2              | 1      | 未查到                                                                                                                                                                                                                 | 支持推理（推理文档列出）[5]                                                                                                                                                                                                                                            | 同 gpt-oss                                                                                                                                           | [1][5][12]         |
| `minimaxai/minimax-m2.7`               | 文本，推理模型，Preview，**仅 Enterprise**                              | 196,608 | 131,072  | 0–2              | 1      | `temperature=1.0`、`top_p=0.95`、`top_k=40`（模型页「官方推荐」）[9]                                                                                                                                                   | 支持推理（推理文档列出）；`reasoning_effort` 可选值未查到 [5]                                                                                                                                                                                                          | —                                                                                                                                                    | [1][5][9]          |
| `llama-3.3-70b-versatile`              | 文本，**仅 Enterprise**（Free / Developer 已于 2026-08-16 下线）        | 131,072 | 32,768   | 0–2              | 1      | 未查到                                                                                                                                                                                                                 | 无                                                                                                                                                                                                                                                                     | —                                                                                                                                                    | [1][10][14]        |
| `llama-3.1-8b-instant`                 | 文本，**仅 Enterprise**（同上）                                         | 131,072 | 131,072  | 0–2              | 1      | 未查到                                                                                                                                                                                                                 | 无                                                                                                                                                                                                                                                                     | —                                                                                                                                                    | [1][11][14]        |
| `meta-llama/llama-prompt-guard-2-22m`  | 提示注入分类器，Preview，**不能用于翻译**；$0.03 / $0.03                | 512     | 512      | —                | —      | —                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                      | —                                                                                                                                                    | [1]                |
| `meta-llama/llama-prompt-guard-2-86m`  | 同上；$0.04 / $0.04                                                     | 512     | 512      | —                | —      | —                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                      | —                                                                                                                                                    | [1][13]            |

非文本模型（不列入翻译候选）：语音识别 `whisper-large-v3`（$0.111/小时）、`whisper-large-v3-turbo`（$0.04/小时）；语音合成 `canopylabs/orpheus-v1-english`（$22/百万字符）、`canopylabs/orpheus-arabic-saudi`（$40/百万字符）。[1]

## 限流与档位

规则 [2]：

- 计量维度：RPM、RPD、TPM、TPD（音频另有 ASH / ASD）；部分组织还单独限制每分钟输入 token（ITPM）和输出 token（OTPM），在控制台 Limits 页把鼠标移到 TPM 上可看到「X in / Y out」拆分。
- 限流按**组织**计；任一维度先到上限就触发。例：RPM 50、TPM 200K 时，一分钟发 50 个 100 token 的请求也会被限。
- 缓存命中的 token 不计入限流，但处理后会从额度里扣减，大量并行请求仍可能触发限流。
- 页面说明这是「高层摘要，可能有例外」，账号的准确值看控制台 https://console.groq.com/settings/limits 。

Free 计划（官方表，全部照抄）[2]：

| 模型 ID                               | RPM | RPD   | TPM  | TPD  | ASH  | ASD   |
| ------------------------------------- | --- | ----- | ---- | ---- | ---- | ----- |
| `canopylabs/orpheus-arabic-saudi`     | 10  | 100   | 1.2K | 3.6K | -    | -     |
| `canopylabs/orpheus-v1-english`       | 10  | 100   | 1.2K | 3.6K | -    | -     |
| `meta-llama/llama-prompt-guard-2-22m` | 30  | 14.4K | 15K  | 500K | -    | -     |
| `meta-llama/llama-prompt-guard-2-86m` | 30  | 14.4K | 15K  | 500K | -    | -     |
| `openai/gpt-oss-120b`                 | 30  | 1K    | 8K   | 200K | -    | -     |
| `openai/gpt-oss-20b`                  | 30  | 1K    | 8K   | 200K | -    | -     |
| `openai/gpt-oss-safeguard-20b`        | 30  | 1K    | 8K   | 200K | -    | -     |
| `qwen/qwen3.8-27b`                    | 30  | 1K    | 8K   | 200K | -    | -     |
| `whisper-large-v3`                    | 20  | 2K    | -    | -    | 7.2K | 28.8K |
| `whisper-large-v3-turbo`              | 20  | 2K    | -    | -    | 7.2K | 28.8K |

Developer 计划基础限额（官方表「Developer Plan Limits」页签，全部照抄；模型页「RATE LIMITS (DEVELOPER PLAN)」列的 RPM / TPM 与此一致）[1][2]：

| 模型 ID                               | RPM | RPD  | TPM  | TPD | ASH  | ASD |
| ------------------------------------- | --- | ---- | ---- | --- | ---- | --- |
| `canopylabs/orpheus-arabic-saudi`     | 250 | 100K | 50K  | -   | -    | -   |
| `canopylabs/orpheus-v1-english`       | 250 | 100K | 50K  | -   | -    | -   |
| `meta-llama/llama-prompt-guard-2-22m` | 100 | 50K  | 30K  | -   | -    | -   |
| `meta-llama/llama-prompt-guard-2-86m` | 100 | 50K  | 30K  | -   | -    | -   |
| `openai/gpt-oss-120b`                 | 1K  | 500K | 250K | -   | -    | -   |
| `openai/gpt-oss-20b`                  | 1K  | 500K | 250K | -   | -    | -   |
| `openai/gpt-oss-safeguard-20b`        | 1K  | 500K | 150K | -   | -    | -   |
| `qwen/qwen3.8-27b`                    | 1K  | 500K | 250K | -   | -    | -   |
| `whisper-large-v3`                    | 300 | 200K | -    | -   | 200K | 4M  |
| `whisper-large-v3-turbo`              | 400 | 200K | -    | -   | 400K | 4M  |

Enterprise 专属模型（`llama-3.1-8b-instant`、`llama-3.3-70b-versatile`、`minimaxai/minimax-m2.7`）的限额在模型页写的是「Contact Sales」。[1]

其他档：Flex 为按需档的 10 倍限额（仅付费用户）[16]；Batch 不占同步限流 [18]；企业可申请更高限额 [2]。

超限返回 [2][16][20]：

- 超限返回 `429 Too Many Requests`；只有 429 时才带 `retry-after`（秒）。
- 其余响应头每次都带，**注意含义**：`x-ratelimit-limit-requests` / `x-ratelimit-remaining-requests` / `x-ratelimit-reset-requests` 指的是**每日请求数（RPD）**，`x-ratelimit-limit-tokens` / `-remaining-tokens` / `-reset-tokens` 指的是**每分钟 token（TPM）**。
- Flex 档容量不足返回自定义状态码 **498**（`capacity_exceeded`），官方建议加抖动退避重试。
- 其他：413 请求体过大；500 服务器错误；503 维护或过载，建议等待后重试。

## 对 DocFlow 的建议

- **预设**：Base URL `https://api.groq.com/openai/v1`、Key 获取页 `https://console.groq.com/keys`，与 `docs/plan/04-translation.md` 4.2 现有预设一致，无需改。
- **新账号安全并发数：1**。新账号都是 Free，gpt-oss 和 qwen3.8 每个模型只有 **8K TPM、200K TPD**。按 DocFlow 默认 `maxRequestChars = 8000` 粗估（英文约 4 字符/token），单个请求约 2K 输入 + 2–3K 输出 token，gpt-oss 还要加推理 token，合计约 4–6K；8K TPM 只够每分钟跑 1 个左右，200K TPD 每天大约 35–50 个请求（以上为估算）。并发开大只会不停吃 429。升级 Developer 后（1K RPM、250K TPM、500K RPD）可以放到 **8**：按每请求约 5K token 估算 250K TPM ≈ 每分钟 50 个请求，留出一半余量。计划里预设默认 `concurrency: 100` 对 Groq 明显过高。
- **多 Key 不增加额度**：限流按组织计，同一组织的多个 Key 轮询没有用，只有不同组织的 Key 才能叠加。[2]
- **默认翻译温度**：gpt-oss 系列**不传**（Groq 默认 1，正好等于 OpenAI 官方推荐的 1.0 / top_p 1.0）[3][21]。qwen3.8-27b 用非思考模式时建议传 `temperature: 0.7`、`top_p: 0.8`（官方非思考推荐值；`top_k`、`presence_penalty` 按文档在 Groq 上无效）[3][8]。
- **思考参数**：
  - gpt-oss：关不掉思考，建议 `reasoning_effort: "low"` 省 token（也省 TPM），并传 `include_reasoning: false` 让响应不带推理文本 [3][5]。
  - qwen3.8-27b：显式传 `reasoning_effort: "none"`（三处文档对默认值说法不一致，不能依赖默认）[3][5][8]。
  - **冲突**：`"none"` 对 gpt-oss 不合法，`"low"` 会让 qwen3.8 开启思考；超出模型支持集合的值直接 400 [3]。DocFlow 的 `extraBody` 是服务商级的，同一个 Groq 服务商下混用两类模型时无法各自设置——需要模型级参数，或让用户为 qwen3.8 单独建一个服务商条目。
- **首选翻译模型**：`openai/gpt-oss-120b`（Production、131K 上下文、65K 输出、$0.15 / $0.60）；想更快更便宜用 `openai/gpt-oss-20b`；`qwen/qwen3.8-27b` 是 Preview 且输出价 $4.00，只作备选。
- **风险提示**：
  1. 模型下线频繁（见「概览」），Preview 模型「可能在短时间内下线」[1][14]；预设不要带默认模型，这一点计划已经做到。
  2. 用户若在 `extraBody` 里设 `service_tier: "flex"`，容量不足会返回 498，而计划 4.5 的分类会把它归为「其他 4xx → rejected」、不重试。建议把 498 归为 `transient`。
  3. `x-ratelimit-*-requests` 是日额度，做自适应并发时不要当成 RPM。
  4. 请求体里不要带 `logprobs`、`logit_bias`、`top_logprobs`、`messages[].name`，`n` 只能为 1，否则 400。[4]
  5. `temperature: 0` 会被改成 `1e-8`，不是真正的贪心解码。[4]

## 来源

1. [Supported Models - GroqDocs](https://console.groq.com/docs/models)（2026-09-23 访问）
2. [Rate Limits - GroqDocs](https://console.groq.com/docs/rate-limits)（2026-09-23 访问；Free / Developer 两个页签）
3. [API Reference - GroqDocs（Create chat completion）](https://console.groq.com/docs/api-reference#chat-create)（2026-09-23 访问）
4. [OpenAI Compatibility - GroqDocs](https://console.groq.com/docs/openai)（2026-09-23 访问）
5. [Reasoning - GroqDocs](https://console.groq.com/docs/reasoning)（2026-09-23 访问）
6. [OpenAI GPT-OSS 120B - GroqDocs](https://console.groq.com/docs/model/openai/gpt-oss-120b)（2026-09-23 访问）
7. [OpenAI GPT-OSS 20B - GroqDocs](https://console.groq.com/docs/model/openai/gpt-oss-20b)（2026-09-23 访问）
8. [Qwen 3.8 27B - GroqDocs](https://console.groq.com/docs/model/qwen/qwen3.8-27b)（2026-09-23 访问）
9. [MiniMax M2.7 - GroqDocs](https://console.groq.com/docs/model/minimaxai/minimax-m2.7)（2026-09-23 访问）
10. [Llama-3.3-70B-Versatile - GroqDocs](https://console.groq.com/docs/model/llama-3.3-70b-versatile)（2026-09-23 访问）
11. [Llama 3.1 8B - GroqDocs](https://console.groq.com/docs/model/llama-3.1-8b-instant)（2026-09-23 访问）
12. [OpenAI GPT-OSS-Safeguard 20B - GroqDocs](https://console.groq.com/docs/model/openai/gpt-oss-safeguard-20b)（2026-09-23 访问）
13. [Llama Prompt Guard 2 86M - GroqDocs](https://console.groq.com/docs/model/meta-llama/llama-prompt-guard-2-86m)（2026-09-23 访问）
14. [Model Deprecation - GroqDocs](https://console.groq.com/docs/deprecations)（2026-09-23 访问）
15. [Billing FAQs - GroqDocs](https://console.groq.com/docs/billing-faqs)（2026-09-23 访问）
16. [Flex Processing - GroqDocs](https://console.groq.com/docs/flex-processing)（2026-09-23 访问）
17. [Service Tiers - GroqDocs](https://console.groq.com/docs/service-tiers)（2026-09-23 访问）
18. [Batch - GroqDocs](https://console.groq.com/docs/batch)（2026-09-23 访问）
19. [Prompt Caching - GroqDocs](https://console.groq.com/docs/prompt-caching)（2026-09-23 访问）
20. [Errors - GroqDocs](https://console.groq.com/docs/errors)（2026-09-23 访问）
21. [openai/gpt-oss README · Recommended Sampling Parameters](https://github.com/openai/gpt-oss#recommended-sampling-parameters)（2026-09-23 访问）
22. [Qwen/Qwen3.8-27B 模型卡（Hugging Face）](https://huggingface.co/Qwen/Qwen3.8-27B)（2026-09-23 访问）
