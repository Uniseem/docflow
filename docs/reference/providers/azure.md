# Azure OpenAI（Microsoft Foundry）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- Azure 托管的 OpenAI 模型（GPT-4.1 系、GPT-5.x、GPT-6 系、o 系、嵌入/图像/实时等），与官方同价区但有区域与配额体系；模型名和可用区域以 Azure 文档为准（Azure 上 GPT-5.5/5.6/6 系均已上线）。[1][2]
- 没有「订阅套餐」：计费绑定 Azure 订阅（后付费/预存），另有按订阅类型区分的**月度 token 上限**（如 `gpt-5`：企业 5B / 默认 200M / 信用卡包月 50M / MSDN 90K）。[1]
- 企业向：有 PTU（预置吞吐）可买断容量，不属于 DocFlow 预设范畴。

## 接入方式

### 按量 API（Azure AI Foundry）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 按 token，与官方价对齐（区域/汇率差异另计）；配额按**订阅 × 区域 × 模型 × 部署类型**分配，新订阅对新型号常见 TPM=0（需提额）。[1][3] |
| Base URL | `https://{资源名}.openai.azure.com/openai/v1`（OpenAI 兼容 v1 端点，规划 4.2 一致）；也可走 `…/openai/deployments/{部署名}/chat/completions?api-version=…` 传统路径。[2] |
| 鉴权方式 | `api-key: ${AZURE_OPENAI_API_KEY}`（规划 4.3 已定，与 OpenAI 的 Bearer 不同）。 |
| Key 获取页 | https://portal.azure.com（在 Azure OpenAI 资源的「Keys and Endpoint」页；规划 4.2 一致）。[3] |

### 订阅套餐

无套餐；PTU 是企业容量采购，不适用。

## 模型

- 与 OpenAI 官方同模型族，但**参数支持以 Azure 文档为准**：「Reasoning models other than GPT-6 Astra don't support the following parameters: temperature、top_p、presence_penalty、frequency_penalty、logprobs、top_logprobs、logit_bias、max_tokens」——即 Azure 上除 `gpt-6-astra` 外，推理模型不要传温度。[2]
- 思考档位 `reasoning.effort`（Responses API）/ chat completions 的 `reasoning_effort`，默认 medium（GPT-5.5 口径）。[2]
- 模型 ID 在 Azure 是**部署名**（用户自定义）或标准模型名，视部署方式而定；「获取模型列表」返回的是该资源下可用模型。

## 限流与档位

### 按量 API

- **配额三维**：订阅 × 区域 × 模型/部署类型各有 RPM 与 TPM；默认档示例（官方表的一部分）：`gpt-6-luna` DataZoneStandard 333 RPM / 333K TPM、GlobalStandard 1,000 RPM / 1M TPM；`gpt-5.5` DataZone 333/333K、Global 1,000/1M；`gpt-5-pro` Global 1,600/160K。档位（Tier 0~6）随订阅类型与消费提升，可用控制面 API 查询。[1]
- **新订阅 TPM=0**：免费试用/新订阅对新型号默认零配额，部署会直接失败（`InvalidCapacity`），必须先提额——这是 Azure 预设最常见的「装不上」原因。[3]
- **配额会不声不响调整**：有官方 Q&A 承认 Global Standard 默认 TPM 可能无预告下调并导致 429；缓解是支持工单 + 指数退避。[4]
- 提额：Quota 请求表单，批准后档位不变、配额增加；政府云无档位概念（默认/企业两档）。[1][5]

### 订阅套餐

无（见概览）。

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | Azure OpenAI | 规划 4.2 已定 |
| Base URL | `https://{资源名}.openai.azure.com/openai/v1`（规划一致；注意azure 类型走 `api-key` 头而非 Bearer） | [2] |
| Key 获取页 | https://portal.azure.com | [3] |
| 新账号安全并发数 | **10**。默认档 333 RPM 的模型 10 并发绰绰有余；且新订阅可能 TPM=0，先把配额问题解决再谈并发。 | [1][3] |
| 翻译请求构造 | 推理模型不传 temperature（除 gpt-6-astra 外都拒绝）；`reasoning_effort: "none"`（Sol/Luna 支持）关闭思考。 | [2] |
| 首选翻译模型 | **`gpt-6-luna`**（Azure 上 Global Standard 1,000 RPM / 1M TPM，成本最低）。 | [1] |
| 界面提示 | Base URL 里的 `{资源名}` 占位要在设置里替换成用户自己的资源名；建议在预设说明里写清楚。 | — |

风险提示：

1. **TPM=0 陷阱**：部署失败 / 429 可能纯粹是配额没批，与 DocFlow 无关；错误提示建议引导用户去 Azure 控制台查 Quotas。[3]
2. **配额静默下调**：Global Standard 会动态调整，DocFlow 的自适应并发是必需兜底。[4]
3. **温度兼容性**：除 gpt-6-astra 外传温度直接 400（Azure 比官方更严格），DocFlow 不要给 azure 预设塞 temperature。[2]
4. **区域差异**：同模型不同区域配额池独立，中国区（由 21Vianet 运营的历史方案）与国际区模型清单不同——用户拿中国区资源配国际模型 ID 会 404。[1][5]

## 来源

1. [Azure OpenAI in Microsoft Foundry Models Quotas and Limits（官方）](https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits)（2026-09-23 访问）
2. [Azure OpenAI reasoning models（官方：参数支持口径）](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)（2026-09-23 访问）
3. [Microsoft Q&A：新订阅 TPM=0 无法部署（官方答复）](https://learn.microsoft.com/en-nz/answers/questions/5816495/)（2026-09-23 访问）
4. [Microsoft Q&A：gpt-5.1 配额无预告下调（官方答复）](https://learn.microsoft.com/en-au/answers/questions/5910070/)（2026-09-23 访问）
5. [Azure Government quotas and limits（官方）](https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits-gov)（2026-09-23 访问）
