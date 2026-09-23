# 火山引擎（豆包 / 火山方舟）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 字节跳动的模型平台「火山方舟」，主力 Doubao-Seed 系列（`doubao-seed-2.1-pro` / `2.1-turbo` / `1.6` / `1.8` / `2.0-lite` / `evolving` 等），另有 Seed-Code 等专用模型；OpenAI / Anthropic 双兼容，走「推理接入点」（Endpoint ID 或模型 ID）调用。[1][2]
- 国内站（火山引擎，人民币计价）；实名认证后开通。
- **有一个订阅套餐：方舟 Coding Plan**（编码场景，Lite/Pro 两档）：专用 Base URL `https://ark.cn-beijing.volces.com/api/coding`（Anthropic 兼容）与 `/api/coding/v3`（OpenAI 兼容），模型用 `ark-code-latest`；三级限额（Lite：每 5 小时约 1,200 次、每周约 9,000 次、每月约 18,000 次；Pro 为其 5 倍量级），不用专用端点会产生额外 API 费用甚至违规预警。[3]

## 接入方式

### 按量 API（console.volcengine.com/ark）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 按 token 人民币计价，缓存命中约为输入价 20%（>10K 长输入生效，缓存 24 小时）；每模型开通有 50 万 token 免费体验额度。[1][4] |
| Base URL | `https://ark.cn-beijing.volces.com/api/v3`（OpenAI 兼容，规划 4.2 一致）。 |
| 鉴权方式 | `Authorization: Bearer ${ARK_API_KEY}`。 |
| Key 获取页 | https://console.volcengine.com/ark（规划 4.2 一致）。 |
| 使用限制 | 需实名认证；限流按账号（含子账号合并）计；**TPM 采用预扣机制**（按输入+预估输出预扣窗口配额），所以「额度有剩余也提示限流」是预期行为。[4] |

价格（每百万 tokens）[1][5]：

| 模型 | 上下文 / 最大输出 | 输入 | 输出 | 缓存命中 | 默认限流 |
| --- | --- | --- | --- | --- | --- |
| `doubao-seed-2.1-pro` | 1M / 256K | ¥6.0 | ¥30.0 | ¥1.2 | RPM 500 / TPM 100 万 |
| `doubao-seed-evolving` | — | — | — | — | RPM 500 / TPM 100 万 |
| `doubao-seed-2.0-lite` | — | — | — | — | 最大 RPM 30,000 |

### 订阅套餐（Coding Plan）

Lite / Pro 两档（价格未在本次抓取中获得 → **未查到**）；三级限流见概览；定位是编码工具套餐，官方明确「不使用指定 Base URL 可能产生额外 API 费用，甚至触发违规使用预警」——**套餐条款面向编码场景，不建议做成 DocFlow 翻译预设**（同 moonshot.md 对 Kimi Code 的结论）。[3]

## 模型

- `doubao-seed-2.1-pro`：1M 上下文、256K 最大输出（`max_tokens` / `max_completion_tokens`），文本+图片+视频输入；思考模式 `minimal/low/medium/high`，**默认 high**；隐式/显式缓存、Batch、Structured Outputs。[1]
- 思考开关：思考档位用官方参数（文档示例为 `thinking` 相关字段，具体参数名以模型页为准）；翻译场景建议 `minimal`。
- 温度 / 采样：未查到按场景推荐表；按 OpenAI 兼容通用参数透传。

## 限流与档位

### 按量 API

- **账号级限流**：每模型设 RPM 与 TPM，主账号+子账号合并计算，具体数值在控制台「开通管理」页查看；提额找客户经理或工单。[4]
- **预扣机制**：收到请求即按输入和输出长度预扣 TPM 配额，防止突发流量挤占——并发越高预扣越激进，表现为高并发下更容易触发限流。[4]
- **低充值账号防控**：「对未在火山引擎上充值或历史充值较低的账号，高并发请求模型会被限制。默认并发数支持尝鲜测试和常规使用」——新账号别指望高并发，充值可解除。[4]
- **Batch chat（批量推理接入点）**：不受 RPM/TPM 限流，并发由平台闲置资源决定，夜间 0–8 点资源充足。[4]

### 订阅套餐

Coding Plan 见前文（不建议做翻译预设）。[3]

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | 火山引擎（豆包） | 规划 4.2 已定 |
| Base URL | `https://ark.cn-beijing.volces.com/api/v3`（规划一致） | — |
| Key 获取页 | https://console.volcengine.com/ark | — |
| 新账号安全并发数 | **10**。低充值账号会被高并发防控，默认 RPM 500 的模型 10 并发（0.17 RPS）安全；lite 系（30,000 RPM）可放宽到 50。 | [4] |
| 翻译请求构造 | 思考档位设 `minimal`（官方思考模式最低档，默认 high 太贵太慢）；温度官方无推荐值，建议不传或用 1.0 左右。 | [1] |
| 首选翻译模型 | 性价比档选 lite 系（`doubao-seed-2.0-lite`，30,000 RPM 极宽松）；高质量选 `doubao-seed-2.1-pro` 非思考/minimal 档。 | [1][4] |
| 模型 ID 说明 | 火山方舟可用「模型 ID」或「接入点 ID」，「获取模型列表」返回什么以方舟控制台为准；用户需先在控制台开通模型。 | [1] |

风险提示：

1. **预扣机制误伤**：高并发时 TPM 预扣会把未完成的请求计入配额，DocFlow 的大输出翻译段容易被预扣挤爆；并发别拉满，429 后自适应降档。[4]
2. **新账号高并发限制**是账号级防控，充值即可缓解；报错文案建议提示「充值或降低并发」。[4]
3. **Coding Plan 别混用**：把普通 API Key 当 Coding Plan 用或反之都会产生意外费用/预警；DocFlow 只对接普通按量端点。[3]
4. **免费额度按模型发放**（50 万 token），开通即用、无有效期限制的说法来自社区实操，官方口径以控制台为准。[6]

## 来源

1. [1M上下文+256k输出：Doubao-Seed-2.1-pro 完全指南（火山引擎官方）](https://www.volcengine.com/article/2945237)（2026-09-23 访问）
2. [模型列表 - 火山方舟](https://www.volcengine.com/docs/82379/1593703)（2026-09-23 访问）
3. [火山方舟 Coding Plan 限流策略详解（官方）](https://www.volcengine.com/article/37852)（2026-09-23 访问）
4. [常见问题 - 火山方舟（预扣机制、账号限流、低充值防控、Batch）](https://www.volcengine.com/docs/82379/1359411)（2026-09-23 访问）
5. [豆包大模型产品页（价格）](https://www.volcengine.com/product/doubao)（2026-09-23 访问）
6. [火山方舟 + opencode 实操（官方社区，免费额度口径）](https://www.volcengine.com/article/2944275)（2026-09-23 访问）
