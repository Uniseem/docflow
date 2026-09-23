# 阿里云百炼（DashScope）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 阿里云的模型平台，主力为通义千问系列（`qwen3.8` / `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.5-plus` / `qwen-plus` / `qwen-turbo` / `qwq` 等），有 OpenAI 兼容模式和 Anthropic 兼容模式两套端点。[1]
- 分地域：华北2（北京）、新加坡、美国（弗吉尼亚）、德国（法兰克福）等；**国内站与国际站价格不同**（如 `qwq-plus` 国内 ¥1.6/¥4，国际 $5.871/$17.614 每 M），免费额度大多仅限华北2。[1][2]
- 无订阅套餐；新开通有模型免费额度（开通/发布/申请通过起 90 天内有效，按输出价折算的额度，见定价页「免费额度」列）。[2]

## 接入方式

### 按量 API（bailian.console.aliyun.com）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 按 token 人民币计价；部分模型输入按区间加价（≤128K / ≤256K / ≤1M 三档）；Batch 调用半价；上下文缓存折扣。[2] |
| Base URL（OpenAI 兼容） | `https://dashscope.aliyuncs.com/compatible-mode/v1`（规划 4.2 一致）。[1] |
| Base URL（Anthropic 兼容） | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`（国际站示例；国内端点以文档为准）。[1] |
| 鉴权方式 | `Authorization: Bearer ${DASHSCOPE_API_KEY}`。 |
| Key 获取页 | https://bailian.console.aliyun.com/?apiKey=1（规划 4.2 一致）。 |
| 使用限制 | 通用服务协议；未查到针对翻译类应用的专门限制。 |

价格摘录（华北2，每百万 tokens，输入/输出/思考模式输出）[2]：

| 模型 | 输入 | 输出（非思考） | 输出（思考） | 免费额度 |
| --- | --- | --- | --- | --- |
| `qwen3.7-plus`（≤256K） | ¥2（限时 8 折） | ¥8（8 折） | ¥8（8 折） | 按输出价折算 |
| `qwen3.6-plus`（≤256K） | ¥2 | ¥12 | ¥12 | 同左 |
| `qwen3.5-plus`（≤128K） | ¥0.8 | ¥4.8 | ¥4.8 | 同左 |
| `qwen-plus`（≤128K） | ¥0.8 | ¥2 | ¥8 | 同左 |
| `qwen-turbo` | ¥0.3 | ¥0.6 | ¥0.6 | ¥3 |
| `qwen3.8-27b`（开源版） | ¥3 | ¥12 | ¥12 | 100 万 Token |

### 订阅套餐

无。

## 模型

- 千问 3.x 系为混合思考模型，**非思考 / 思考（思维链+回答）按不同输出价计费**（思考更贵，见上表）；思考开关按 Qwen 系惯例用 `enable_thinking` / `chat_template_kwargs` 或 Anthropic 兼容端的 `thinking: {"type": "enabled"/"disabled"}`。[1]
- Anthropic 兼容端的 temperature 官方注明**范围是 [0, 2)，与 Anthropic 官方的 [0.0, 1.0] 不同**，迁移时要核对取值。[1]
- 上下文：旗舰 1M（>256K 输入加价），plus 系 128K~256K 起步。

## 限流与档位

### 按量 API

- **按模型的 RPM 表**（官方限流页，摘录）[3]：

  | 模型 | RPM |
  | --- | --- |
  | `qwen3-max` 系 | 60（preview 600） |
  | `qwen-max` | 1,200 |
  | `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.5-plus` / `qwen-plus` / `qwen3.x-flash` | 30,000 |
  | 各带日期的历史快照（`...-2026-04-02` 等） | 600 |

  原文：「以下为每分钟限流条件，服务可能按 RPS（RPM/60）与 TPS（TPM/60）限制」「超出任一数值时触发限流」；**Batch API 调用不受限流限制**。[3]
- TPM 数值：官方页有模型级 TPM 列，本次抓取未完整获得 → 以限流页为准。[3]
- 超限返回：未查到专文；按 OpenAI 兼容通用 429 处理。

### 订阅套餐

无。

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | 阿里云百炼 | 规划 4.2 已定 |
| Base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1`（规划一致） | [1] |
| Key 获取页 | https://bailian.console.aliyun.com/?apiKey=1 | — |
| 新账号安全并发数 | **50**。主力模型 RPM 上限 600~30,000，并发 50（≈0.83 RPS）远低于任何一档；qwen3-max 系只有 60 RPM，选了它再降。 | [3] |
| 翻译请求构造 | 建议关闭思考（省输出费）：OpenAI 兼容端按 Qwen 惯例传 `chat_template_kwargs: {"enable_thinking": false}`（以模型页说明为准）；Anthropic 兼容端用 `thinking: {"type": "disabled"}`。温度范围 [0,2)，翻译可用 1.0 左右，但官方未给按场景推荐表。 | [1] |
| 首选翻译模型 | **`qwen-plus`**（¥0.8/¥2，128K 上下文，非思考输出便宜）；高质量用 `qwen3.7-plus` 非思考档。 | [2][3] |
| max_tokens | 不设置；截断再调 | — |

风险提示：

1. **思考模式加价**：同一模型思考输出价 = 非思考价（如 qwen3.7-plus 恰好同价）或数倍（qwen-plus 思考 ¥8 vs 非思考 ¥2），不关思考等于白白多花钱。[2]
2. **地域价差**：国际站单价按美元/当地币种显著更高，且免费额度大多仅限北京地域；DocFlow 用户若走国际端点注意核对价格表。[1][2]
3. **历史快照限速低**：带日期的快照模型（`-2026-04-02` 等）只有 600 RPM，「获取模型列表」可能同时返回新旧 ID，选错会被意外限速。[3]
4. **免费额度会过期**：90 天有效期，过期后静默转付费，界面可提示。[2]

## 来源

1. [Anthropic-compatible Messages API | Model Studio](https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages)（2026-09-23 访问）
2. [模型调用价格 - 阿里云文档](https://help.aliyun.com/zh/model-studio/model-pricing)（2026-09-23 访问）
3. [限流 - 大模型服务平台百炼](https://help.aliyun.com/zh/model-studio/rate-limit)（2026-09-23 访问）
