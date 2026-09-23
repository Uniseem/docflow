# ADR-0011：服务商预设以官方调研为准，请求默认不传温度

- 状态：已采纳
- 日期：2026-09-23
- 相关：R5、docs/plan/04-translation.md（4.2、4.3）、docs/reference/providers/、worklog 2026-09-23-providers / providers-round2 / presets

## 背景

规划 4.2 的 20 个预设照搬自 3.x。2026-09-23 按官方文档逐家调研 19 个云端服务商（`docs/reference/providers/`）后发现：

- 零一万物已于 2026-09-03 停止 API 服务，`lingyi` 预设会让用户配置一个必然失败的服务商。
- MiniMax 有稳定的 OpenAI 兼容接口，且官方允许 Token Plan 接任意 OpenAI 兼容工具，3.x 没有它。
- DeepSeek 官方 Base URL 不带 `/v1`（`/v1` 仍兼容）。
- 2026 年主流模型多是推理模型：OpenAI、Azure、Anthropic 新款、Gemini 3 对非默认 `temperature` 报 400 或会反复输出（looping）；只有 DeepSeek（1.3，且关思考）、MiMo 等少数模型适合显式传温度。
- 各家新账号的安全并发差别很大（1 到 100）。

## 决定

- 预设表保持 20 个：移除 `lingyi`，在原位置（国内服务组）新增 `minimax`（`https://api.minimaxi.com/v1`）；`deepseek` 的 Base URL 改为 `https://api.deepseek.com`。
- 翻译请求**默认不传 `temperature`**，用各模型的默认值。需要固定温度的由用户在服务商的「附加请求参数」（extraBody）里配置，代码不按服务商写死温度。
- 预设结构保持 `{ id, name, type, baseUrl, keyUrl, group }`，不加默认并发、默认 extraBody、思考开关字段。并发仍用 `ProviderConfig.concurrency` 默认 100 + 429 自适应降速兜底；各家推荐值留在调研笔记里。
- 以后改预设先更新 `docs/reference/providers/` 对应文件，再改 `src/shared/presets.ts`。

## 备选方案

- **按服务商或模型写死推荐温度**：模型更新频繁（改名、默认开思考、弃用温度），写死的值很快过时，还会让推理模型直接报 400。放弃。
- **预设里带默认并发与思考开关**：更贴近各家限制，但需要扩展预设 schema 和设置迁移；自适应并发已经能从 429 恢复。留到有明确需要时再做。
- **保留 `lingyi` 以维持与 3.x 一致**：平台已停运，保留只会制造无效配置。放弃。
- **新增 MiniMax Token Plan 作为第二个预设**：同一端点、不同 Key 前缀，用户用同一个 `minimax` 预设填 Key 即可。暂不加。

## 后果

- 好处：预设都指向可用的服务；推理模型不会因为温度参数失败；预设表与调研笔记一一对应、有出处。
- 代价 / 风险：DeepSeek 用户不配置 extraBody 时得不到官方推荐的 1.3 温度（翻译质量略有差别，不会失败）；新账号并发低的服务商（Moonshot、Groq、Gemini 免费档）开头会有一轮 429 再降速。
- 需要跟进的事：界面在服务商详情里提示推荐的 extraBody（如 DeepSeek 的温度与关闭思考）；定期重新核对调研笔记。
