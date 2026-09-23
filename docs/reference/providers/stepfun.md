# 阶跃星辰（StepFun）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 多模态模型公司，Step 系列：`step-5-preview`（1M 上下文，2026-09 限免体验中）、`step-3.7-flash`（256K 上下文/256K 输出，MoE 198B 激活 11B，开源 Apache 2.0）、`step-3.5-flash`、`step-3`、`step-2`（旗舰）及语音视觉系。[1][2]
- 双区域：中国区 `api.stepfun.com`、国际区 `api.stepfun.ai`，Key 不通用（推定分账号体系，未查到明确说明）。[3]
- **有订阅套餐：Step Plan**——面向编码工具（Claude Code / Cursor / OpenClaw 等）的月度 Credit 池，专用端点 `https://api.stepfun.com/step_plan/v1`；标准按量端点与 Plan 端点分开计量。[3][4]

## 接入方式

### 按量 API（platform.stepfun.com）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 按 token 人民币计价；**思考模式下思维链按输出 token 计费**；官方定价页写明「阶梯限速适用于标准 API（按量付费）；Step Plan 用量单独计算」。[3][5] |
| Base URL | `https://api.stepfun.com/v1`（中国区，规划 4.2 一致）；国际区 `https://api.stepfun.ai/v1`。[3] |
| 鉴权方式 | `Authorization: Bearer ${STEPFUN_API_KEY}`。 |
| Key 获取页 | https://platform.stepfun.com/interface-key（规划 4.2 一致）。 |

价格（每百万 tokens）[1][2][5]：

| 模型 | 输入 | 输出 | 上下文/最大输出 | 备注 |
| --- | --- | --- | --- | --- |
| `step-3.7-flash` | $0.20（国际官方）/ ¥1.35（百炼托管） | $1.15 / ¥8.1 | 256K / 256K | 缓存读 $0.04；百炼托管限速 RPM 500 / TPM 2,000 万 |
| `step-3` | ¥1.5（限时折扣） | ¥4 | — | 2025-07 开源发布口径 |
| `step-5-preview` | 限免一个月（2026-09 活动） | 同左 | 1M | 活动规则以平台页为准 |

### 订阅套餐（Step Plan）

月度 Credit 池，专用路径前缀 `/step_plan/v1`，主要面向第三方编码工具的接入；**不建议做成 DocFlow 翻译预设**（套餐定位编码场景）。价格未抓取到 → **未查到**。[3][4]

## 模型

- 思考开关：`enable_thinking`（百炼托管文档口径：`支持通过 enable_thinking 开启思考模式`）；Step 3.7 Flash 支持 low/medium/high 三档推理强度。[1][5]
- 温度/采样：未查到按场景推荐表。

## 限流与档位

### 按量 API

- 官方定价页确认实行「**阶梯限速**」（按用户等级分档），但各档具体 RPM/TPM 数值未在抓取中获得 → **未查到**，以平台「定价与限速」页与控制台为准。[5]
- 旁证（百炼托管的 step-3.7-flash）：RPM 500 / TPM 2,000 万——官方向第三方放量时的量级参考，不代表 stepfun.com 自营档。[1]

### 订阅套餐

Step Plan 见前文（不建议做翻译预设）。

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | 阶跃星辰 | 规划 4.2 已定 |
| Base URL | `https://api.stepfun.com/v1`（规划一致） | [3] |
| Key 获取页 | https://platform.stepfun.com/interface-key | — |
| 新账号安全并发数 | **10**。自营限速未公开，10 起步靠自适应；step-3.7-flash 量级宽松（第三方托管都到 500 RPM）。 | [1][5] |
| 翻译请求构造 | 关闭思考（`enable_thinking: false`，省输出费——思维链按输出计费）；温度不传或 1.0。 | [5] |
| 首选翻译模型 | **`step-3.7-flash`**（便宜、256K 输出、400 tokens/s 官方标称）；限时免费用 `step-5-preview`（注意活动结束后按价计费）。 | [1][2] |
| 注意 | 中国区/国际区端点不同，用户 Key 从哪个区申请就配哪个 Base URL。 | [3] |

风险提示：

1. **思考计费**：思维链按输出 token 计费且 256K 思维链上限很大，不关思考成本失控。[5]
2. **限免活动窗口**：step-5-preview 一个月限免是拉新活动，过期转付费，用户可能无感；界面不显示价格，用户自己要看平台页。[2]
3. **限速不公开**：「阶梯限速」具体档位未知，429 只能靠自适应。[5]
4. **模型跨度大**：从 step-2 到 3.5/3.7/5 并存，命名乱，获取模型列表后让用户自己挑。[1]

## 来源

1. [stepfun/step-3.7-flash 模型信息 - 阿里云文档](https://help.aliyun.com/zh/model-studio/step-3-7-flash)（2026-09-23 访问）
2. [Step 3.7 Flash 介绍（含官方定价引用）](https://www.aitoollab.cn/tools/step-3-7-flash/)（2026-09-23 访问）
3. [OpenClaw 接入 StepFun：双端点对照](https://www.studynil.com/ai/ai-tools/openclaw/providers/stepfun.html)（2026-09-23 访问）
4. [StepFun 订阅套餐与 API 价格汇总](https://aiplans.dev/zh/plans/stepfun)（2026-09-23 访问）
5. [定价与限速 - StepFun 开放平台文档中心（官方）](https://platform.stepfun.com/docs/zh/guides/pricing/details)（2026-09-23 访问）
6. [Step-5-preview 限免领取教程（2026-09）](https://www.cnblogs.com/wlor/articles/23051630)（2026-09-23 访问）
