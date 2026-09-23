# 大模型服务商调研

每个厂商一个文件，记录接入方式、模型参数（温度范围、默认值、官方推荐档位、思考开关）、限流档位与并发，以及对 DocFlow 预设的建议。`src/shared/presets.ts` 与模型目录里的默认值都应能在这里找到出处；改预设前先更新这里。

## 规则

- 只以官方来源为准（文档、定价页、限流页、官方公告）。每个数字都对应文末的来源编号；查不到写「未查到」，不凭记忆补。
- **按量付费 API** 与 **订阅套餐**（Token Plan / Coding Plan / 会员等，以厂商官方名称为准）分开记录：两者的 Base URL、Key、额度与使用条款通常都不同，在 DocFlow 里也是两个独立的预设。
- 国内站与国际站分开记录；Key 一般不通用。
- 每个文件开头写查证日期。厂商更新频繁（模型改名、下线、思考模式默认开启等），重新核对时整段改写并更新日期，不要只改一个数字。

## 文件结构

1. 概览：模型系列、有无国际站、有无订阅套餐。
2. 接入方式：按量 API 与订阅套餐分表，含 Base URL、鉴权、Key 获取页、使用限制原文。
3. 模型：每个文本对话模型的类型、上下文、最大输出、`temperature` 范围与默认值、官方推荐值（按场景的档位表原样抄录，标出翻译场景）、思考开关参数、其他采样限制。
4. 限流与档位：按量 API 的等级划分与各档 RPM / TPM / 并发；订阅套餐各档的价格、额度与并发。
5. 对 DocFlow 的建议：预设显示名、Base URL、默认并发、按模型的翻译温度、是否默认关闭思考、首选翻译模型、风险提示。
6. 来源。

## 进度

查证日都是 2026-09-23。下面是给预设用的结论摘要，依据和「未查到」的项在各厂商文件里。净改动 1–3 已在 2026-09-23 落到 `src/shared/presets.ts`，见下方「状态」。

### 已完成（第一轮 + 第二轮，共 19 家）

| 文件                             | 对应预设              | 新账号并发              | 翻译温度                              | 思考                                             | 首选模型                              | 订阅套餐                                            |
| -------------------------------- | --------------------- | ----------------------- | ------------------------------------- | ------------------------------------------------ | ------------------------------------- | --------------------------------------------------- |
| [deepseek.md](deepseek.md)       | `deepseek`            | 100                     | 1.3，且必须同时关闭思考               | 默认关闭                                         | `deepseek-flash`                      | 无                                                  |
| [groq.md](groq.md)               | `groq`                | 1（Developer 档可到 8） | gpt-oss 不传；qwen3.8 非思考用 0.7    | 两系列参数冲突，不能共用一条服务商级 `extraBody` | `openai/gpt-oss-120b`                 | 无                                                  |
| [moonshot.md](moonshot.md)       | `moonshot`            | 1                       | 不发送，现役模型温度固定              | 只有 `kimi-k2.6` 能关                            | `kimi-k2.6`                           | Kimi Code 不建议做成预设                            |
| [mimo.md](mimo.md)               | 规划里还没有          | 4                       | 1.0，且必须同时关闭思考               | 默认关闭                                         | `mimo-v2.6-flash`                     | Token Plan 不建议做成预设                           |
| [openai.md](openai.md)           | `openai`              | 20                      | 不传（推理模型拒绝非默认值）          | `reasoning_effort: "none"`（Astra 除外）         | `gpt-6-luna`                          | 无                                                  |
| [anthropic.md](anthropic.md)     | `anthropic`           | 10                      | 不传（新款模型弃用 temperature）      | 5 系 Adaptive 常开，不可关                       | `claude-haiku-4.5`                    | 无                                                  |
| [gemini.md](gemini.md)           | `gemini`              | 3（Tier 1 后 20）       | **不传**（Gemini 3 低温度会 looping） | `thinkingBudget: 0` 尝试关闭                     | `gemini-3.1-flash`                    | 无                                                  |
| [openrouter.md](openrouter.md)   | `openrouter`          | 20                      | 不传（透传给上游，上游各自为政）      | 不做服务商级开关                                 | 不写死，可用 `openrouter/auto`        | 无                                                  |
| [siliconflow.md](siliconflow.md) | `siliconflow`         | 20                      | 不做一刀切（上游模型族语义冲突）      | 同上                                             | 不写死（上下线频繁）                  | 无                                                  |
| [dashscope.md](dashscope.md)     | `dashscope`           | 50                      | 官方无推荐表；建议不传或 1.0          | 关闭思考省输出费（思考加价）                     | `qwen-plus`                           | 无                                                  |
| [volcengine.md](volcengine.md)   | `volcengine`          | 10（lite 系可到 50）    | 不传或 1.0                            | 思考档位 `minimal`（默认 high）                  | `doubao-seed-2.0-lite`                | Coding Plan 不建议做成预设                          |
| [zhipu.md](zhipu.md)             | `zhipu`               | 5（免费 flash 只能 1）  | 不传或 1.0                            | 以模型页为准                                     | `glm-5.3-flash`                       | Coding Plan 不建议做成预设                          |
| [hunyuan.md](hunyuan.md)         | `hunyuan`             | 5                       | 不传                                  | 未查实前保持默认                                 | `hunyuan-translation`（专用翻译模型） | Coding Plan 不建议做成预设                          |
| [stepfun.md](stepfun.md)         | `stepfun`             | 10                      | 不传或 1.0                            | `enable_thinking: false`（思维链按输出计费）     | `step-3.7-flash`                      | Step Plan 不建议做成预设                            |
| [lingyi.md](lingyi.md)           | ~~`lingyi`~~ **移除** | —                       | —                                     | —                                                | 平台已关停（2026-09-03 停止 API）     | —                                                   |
| [xai.md](xai.md)                 | `xai`                 | 10                      | 不传                                  | 选 non-reasoning 模型即无需开关                  | `grok-4-fast-non-reasoning`           | 无                                                  |
| [mistral.md](mistral.md)         | `mistral`             | 3（付费后 10）          | 不传（默认 0.7）                      | 非思考模型为主                                   | `mistral-small-4`                     | 无（Le Chat Pro 不含 API）                          |
| [azure.md](azure.md)             | `azure`               | 10                      | 不传（除 gpt-6-astra 外都拒绝）       | `reasoning_effort: "none"`                       | `gpt-6-luna`                          | 无（PTU 另计）                                      |
| [minimax.md](minimax.md)         | 需新增                | 10                      | 不传                                  | M 系为推理模型，开关待查实                       | `MiniMax-M3`                          | **Token Plan 可做成第二个预设**（与 mimo 结论不同） |

### 对预设清单的净改动（改 `presets.ts` 前确认）

1. **移除 `lingyi`**：零一万物平台 2026-09-03 已停止 API 服务。
2. **新增 `minimax`**（按量）与可选的 **MiniMax Token Plan 预设**（sk-cp Key，同一端点）。
3. DeepSeek Base URL 从 `api.deepseek.com/v1` 改为官方写法 `api.deepseek.com`（见 deepseek.md）。
4. 大多数服务商**不要**在预设里塞默认温度——2026 年主流模型是推理模型，温度要么被拒绝要么被忽略；DeepSeek（1.3+关思考）和 MiMo 是少数例外。
5. Ollama、LM Studio、自定义服务商不单独调研。

### 状态

2026-09-23 已落实（见 [ADR-0011](../../adr/0011-provider-presets-follow-research.md) 与 worklog [2026-09-23-presets](../../worklog/2026-09-23-presets.md)）：

- 1–3：`presets.ts` 移除 `lingyi`、新增 `minimax`（按量），DeepSeek Base URL 去掉 `/v1`。MiniMax Token Plan 预设暂不加。
- 4：请求代码本来就不传 `temperature`，维持不变；需要固定温度的（DeepSeek 1.3、MiMo 1.0）由用户在附加请求参数里配置。
- 表中的「新账号并发」「思考开关」没有写进预设，预设结构仍是 `{id,name,type,baseUrl,keyUrl,group}`，并发靠默认值 + 429 自适应。
