# 硅基流动（SiliconFlow）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 国内模型聚合平台（京东/清华系），托管 DeepSeek、Qwen、GLM、Kimi、MiniMax、混元等国产模型，OpenAI 兼容接口；按人民币充值按量计费。
- 国内站 cloud.siliconflow.cn；原国际端点 `api.siliconflow.com` 自 2025-03 起逐步淘汰，官方要求改用 `api.siliconflow.cn`（GTM 全球加速）。未发现独立的国际站账号体系。[1]
- 无订阅套餐，充值按量扣费；部分小模型（Qwen 系小尺寸）标注「免费」。[2]

## 接入方式

### 按量 API（cloud.siliconflow.cn）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 充值后按 token 扣费，人民币计价；含缓存价（约为输入价的零头）；**部分模型分时段计价**（如 DeepSeek-V4-Flash：2 点～8 点 ¥1.5/¥4.5 每 M，其余时段更高；混元 9 点～18 点为高峰价）。[2][3] |
| Base URL | `https://api.siliconflow.cn/v1`（规划 4.2 一致；`/v1/chat/completions`、`/v1/models`）。[1] |
| 鉴权方式 | `Authorization: Bearer ${SILICONFLOW_API_KEY}`。 |
| Key 获取页 | https://cloud.siliconflow.cn/account/ak（规划 4.2 一致）。 |
| 使用限制 | **实名认证**：2026-05-15 起未认证账号将被限制平台功能；未认证 historically 还有 RPD 100 的限额（2025-02 公告口径，可能已调整）。[3] |

### 订阅套餐

无。

## 模型

- 模型 ID 形如 `deepseek-ai/DeepSeek-V4-Pro`、`Qwen/Qwen3.6-...`、`THUDM/GLM-4.7`、`moonshotai/Kimi-K2.5`、`MiniMaxAI/MiniMax-M2.5` 等（上下线频繁，以模型页为准）。[2][3]
- 温度 / 思考参数语义跟随上游模型（如 DeepSeek 系的 `thinking.disabled`、Qwen3 系的 thinking 开关），平台原样透传；未查到平台级统一约定。
- 免费模型：定价页标注「免费」的小尺寸模型，适合联调不适合翻译质量。

## 限流与档位

### 按量 API

- **没有统一限速表**：官方 Quickstart 写明在模型详情页查看「the highest speed limit available to users」，即限速按模型给出、各不相同。[4]
- 平台会不定期调整限速（公告例：2025-11-11 起调低 `Pro/deepseek-ai/DeepSeek-R1`、`Pro/deepseek-ai/DeepSeek-V3`、GLM-4.6、Ling/Ring-1T、MiniMax-M2 等的 Rate Limits，高并发需联系商务申请提额）。[3]
- 历史口径：DeepSeek-R1/V3 曾限 30 RPH，未实名 100 RPD；2025-02 公告称取消 RPH/RPD 限制——**现行数值以模型详情页为准**。[3]
- 429 处理：未查到官方对响应头 / 重试语义的专文，按通用 OpenAI 兼容行为处理。

### 订阅套餐

无。

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | 硅基流动 | 规划 4.2 已定 |
| Base URL | `https://api.siliconflow.cn/v1`（规划一致，正确） | [1] |
| Key 获取页 | https://cloud.siliconflow.cn/account/ak | — |
| 新账号安全并发数 | **20**。平台按模型限流、热门模型（DeepSeek/GLM）曾主动收紧，20 并发配合 429 自适应；模型详情页查到具体限速后再调。 | [3][4] |
| 翻译请求构造 | 不做服务商级 temperature / thinking 一刀切（上游模型族语义互相冲突，同 groq.md 教训）；由用户按所选模型配置 extraBody。 | — |
| 首选翻译模型 | 不写死（上下线太频繁）；选型时优先非思考的国产主力（DeepSeek-V4 系、Qwen3.6 非思考档），以模型页「最高限速」和单价为准。 | [2][3] |
| 提示 | 界面可提示用户完成实名认证，避免功能受限。 | [3] |

风险提示：

1. **限速按模型且随时调整**：官方公告保留「随流量负载随时调整」的权利， preset 层面不要假设某个模型永远宽松。[3]
2. **分时段计价**：部分模型高峰时段 2 倍以上价差，批量翻译放夜间更便宜。[2]
3. **模型生灭快**：Kimi-K2、GLM-4.6 等说停就停（公告列表一长串），预设不写死模型 ID。[3]
4. **实名要求**：未实名账号 2026-05-15 起受限，Key 失效报错可能与此有关。[3]

## 来源

1. [SiliconFlow 更新公告（端点淘汰等）](https://docs.siliconflow.cn/cn/release-notes/overview)（2026-09-23 访问）
2. [大模型 API 价格方案](https://siliconflow.cn/pricing)（2026-09-23 访问）
3. [更新公告（Rate Limits 调整、实名认证、模型停服）](https://docs.siliconflow.cn/cn/release-notes/overview)（2026-09-23 访问）
4. [Quickstart（模型详情页查限速）](https://docs.siliconflow.cn/en/userguide/quickstart)（2026-09-23 访问）
