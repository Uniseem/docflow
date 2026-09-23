# MiniMax（稀宇科技）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 主力模型：`MiniMax-M3`（旗舰，1M 上下文，原生多模态 Coding/Agentic）、`MiniMax-M2.7` / `M2.7-highspeed`；M2.5/M2.1/M2 已归 Legacy，Text-01 与 abab6.5s 已下架。语音（speech-2.8）、视频（Hailuo/H3）、图像、音乐线齐全。[1][2]
- 双区域：中国区 `api.minimaxi.com`、国际区 `api.minimax.io`，OpenAI 与 Anthropic 双兼容。[3]
- **订阅套餐：Token Plan**（2026-03 由 Coding Plan 升级而来）：Plus ¥49/月、Max ¥119/月、Ultra ¥469/月；5 小时固定窗口 + 周窗口双限额；全模态共享额度；专用 `sk-cp` Key 可接任意 OpenAI 兼容工具。[1][4]

## 接入方式

### 按量 API（platform.minimaxi.com）

| 项目       | 内容                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式   | 按 token 计价；缓存读/写分开计价；`service_tier: "priority"` 1.5 倍价换优先准入；无免费模型层，注册+实名认证后按需充值（历史「注册送券」说法已无法复核，不予采信）。[1][2] |
| Base URL   | `https://api.minimaxi.com/v1`（中国区）；`https://api.minimax.io/v1`（国际区）。                                                                                           |
| 鉴权方式   | `Authorization: Bearer ${MINIMAX_API_KEY}`。                                                                                                                               |
| Key 获取页 | https://platform.minimaxi.com（控制台 API Key 管理）。                                                                                                                     |

价格（每百万 tokens，输入/输出/缓存读/缓存写）[2]：

| 模型                     | 输入                              | 输出  | 缓存读 | 缓存写 |
| ------------------------ | --------------------------------- | ----- | ------ | ------ |
| `MiniMax-M2.7`           | $0.30                             | $1.20 | $0.06  | $0.375 |
| `MiniMax-M2.7-highspeed` | $0.60                             | $2.40 | $0.06  | $0.375 |
| `MiniMax-M2.5`（Legacy） | $0.30                             | $1.20 | $0.03  | $0.375 |
| `MiniMax-M3`             | 未在抓取中获得 → 以官方定价页为准 | —     | —      | —      |

### 订阅套餐（Token Plan）

Plus ¥49/月（约 12,000 次 M3 编程调用/月、M2.7 1,500 次/5 小时）、Max ¥119/月、Ultra ¥469/月；额度按按量价折算扣减，窗口内用不完不结转；少量特殊模型（H3、音色设计）除外。[4]

**对 DocFlow 的意义**：Token Plan 不限定于编程工具（官方定位「个人开发者、Coding 用户、日常办公场景」，可接任意 OpenAI 兼容工具），且 M3 是 1M 上下文多模态——**与 MiMo 的 Token Plan 结论不同，MiniMax Token Plan 可以做成第二个预设**（type openai，Base URL `https://api.minimaxi.com/v1`，Key 为 sk-cp 开头），但要在预设说明里写明：额度按 5 小时/周窗口滚动，批量翻译可能撞窗口上限。

## 模型

- M3：1M 上下文，原生多模态（图像/视频输入）；M2.7：上下文 196K~262K（各渠道口径不一），400 tokens/s 级高速档 highspeed。[1][2]
- 思考开关：未查到统一官方参数名（M 系为推理模型，思维链按输出计费）→ 以模型页为准。

## 限流与档位

### 按量 API

- 官方口径：超出 RPM/TPM 会限流，**通常约 1 分钟恢复**，高峰期可能动态收紧；具体数值未公开表 → 以控制台为准。[1]

### 订阅套餐

Token Plan 的限额是「5 小时窗口 + 周窗口」的请求数/折算额度（见接入方式）。[4]

## 对 DocFlow 的建议

| 项                     | 建议                                                                                   | 依据                        |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| 显示名                 | MiniMax                                                                                | 规划 4.2 里没有，需新增预设 |
| Base URL（按量）       | `https://api.minimaxi.com/v1`（中国区）                                                | [3]                         |
| Base URL（Token Plan） | 同一端点，Key 换成 sk-cp 的 Token Plan Key                                             | [4]                         |
| Key 获取页             | https://platform.minimaxi.com                                                          | —                           |
| 新账号安全并发数       | **10**（限速未公开，保守起步）。                                                       | [1]                         |
| 翻译请求构造           | M 系为推理模型：不传温度，能关思考则关（参数名待查实）；M3 1M 上下文适合整篇论文直喂。 | [1]                         |
| 首选翻译模型           | **`MiniMax-M3`**（1M 上下文、多模态）；按量便宜档 `MiniMax-M2.7`。                     | [1][2]                      |

风险提示：

1. **无免费层**：注册不送可复核的赠金，试翻译效果要先充值；引导用户先用 Token Plan 月费档试错。[1]
2. **窗口限额不结转**：Token Plan 用户批量翻译撞 5 小时窗口的概率高，错文言论文档应提示「周窗口还够用」。[4]
3. **模型换代快**：M2→M2.1→M2.5→M2.7→M3 一年半五代，预设不写死模型 ID。[1][2]
4. **双区域**：中国区/国际区 Key 与价格体系分开（国际站 $ 计价），预设默认中国区。[3]

## 来源

1. [free-llm-intel：MiniMax 章节（抓自官方页）](https://github.com/rockbenben/free-llm-intel)（2026-09-23 访问）
2. [Pay as You Go - MiniMax API Docs（官方国际定价）](https://platform.minimax.io/docs/guides/pricing-paygo)（2026-09-23 访问）
3. [OpenClaw MiniMax 文档（双端点口径）](https://docs.openclaw.ai/zh-CN/providers/minimax)（2026-09-23 访问）
4. [Token Plan 概要 - MiniMax 开放平台文档中心（官方）](https://platform.minimax.cn/docs/token-plan/intro)（2026-09-23 访问）
5. [MiniMax Token Plan 升级报道（智东西）](https://m.zhidx.com/p/542084.html)（2026-09-23 访问）
