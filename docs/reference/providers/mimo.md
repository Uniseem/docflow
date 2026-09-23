# 小米 MiMo 开放平台（Xiaomi MiMo API Open Platform）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 现役文本对话模型为 MiMo-V2.6 系列：`mimo-v2.6-pro`、`mimo-v2.6-flash`、`mimo-v2.6-pro-ultraspeed`，2026-09-22 发布。另有 `mimo-v2.5-pro`、`mimo-v2.5` 两款旧型号，定于**北京时间 2026-10-21 10:00 下线**，到期不做替换路由，直接失效。所有现役模型都是 1M 上下文、最大输出 128K 的混合思考模型，**默认开启思考**。[2][6][15][16]
- 国内外用户共用 platform.xiaomimimo.com 和同一套文档，没有单独的国际站。区别在账号所在地区：国内用人民币计价，海外用美元；官方 FAQ 原文是「根据账号所在地区返回不同的 Base URL + Key，不互通」。[1][11][12]
- 有订阅套餐 **Token Plan**（个人版、团队版）。它的 Base URL 和 Key 都与按量 API 分开，**条款只允许在编程工具里使用**，详见下文。另有 Xiaomi MiMo Desktop 会员和 MiMo Claw 订阅，二者都属于小米自家产品内的会员，不给第三方 API 用。[9][10][14][19]
- 服务在正常运营。2026-09-22 刚上线 V2.6 系列，按量价格与 V2.5 相同。[16][18]

## 接入方式

### 按量 API（Pay-as-you-go MiMo API）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 从账户余额扣费，按实际 token 计。输入分缓存命中和未命中两档。国内按「元 / 百万 tokens」计，海外按「美元 / 百万 tokens」计。缓存写入限时免费，联网搜索按次单独收费。原文：「按量计费使用开放平台普通 API Key，并按实际 Token 用量消耗账户余额，与 Token Plan 套餐额度不互通」[8] |
| OpenAI 兼容 Base URL | `https://api.xiaomimimo.com/v1`（实时推理）[1][5]。批量推理（Batch API）另用 `https://batch-api-cn.xiaomimimo.com/v1`，控制台「批量推理」页会给出专属地址，与 DocFlow 无关 [1] |
| Anthropic 兼容 Base URL | `https://api.xiaomimimo.com/anthropic` [1] |
| 海外账号的 Base URL | 文档只列了上面这一个地址。FAQ 说按账号所在地区返回不同的 Base URL 和 Key，但海外按量地址**未查到**，以控制台展示为准 [11] |
| 鉴权方式 | 二选一：`api-key: $MIMO_API_KEY` 或 `Authorization: Bearer $MIMO_API_KEY` [5][12]。Key 格式为 `sk-xxxxx` [1] |
| Key 获取页 | https://platform.xiaomimimo.com/#/console/api-keys [1][12] |
| Key 是否与套餐通用 | 不通用。原文：「Token Plan 的 API Key 格式为 tp-xxxxx，仅用于 Token Plan 订阅服务；按量付费 API 调用的 API Key 格式为 sk-xxxxx，用于按量计费。两者相互独立，不可混用。」混用会返回 401 [4][12] |
| 使用限制 | 按量 API 没查到限定使用场景的条款。官方「AI 工具总览」写的是按量 API 与 Token Plan「均支持在以下主流 AI 编程工具中使用」，这句话不构成限制 [10]。平台会审核输入和输出内容，违规会被拦截（HTTP 421）[4][12] |
| 账号 | 用小米账号登录。国内用户充值或买套餐前要做个人或企业实名认证 [11] |

国内实时推理价格，单位为元 / 百万 tokens [8]：

| 模型 | 输入·命中缓存 | 输入·未命中缓存 | 输出 |
| --- | --- | --- | --- |
| `mimo-v2.6-pro`、`mimo-v2.5-pro`（即将下线） | ¥0.025 | ¥3.00 | ¥6.00 |
| `mimo-v2.6-flash`、`mimo-v2.5`（即将下线） | ¥0.02 | ¥1.00 | ¥2.00 |
| `mimo-v2.6-pro-ultraspeed` | ¥0.25 | ¥30.00 | ¥60.00 |

海外实时推理价格，单位为美元 / 百万 tokens [8]：pro 档依次为 $0.0036 / $0.435 / $0.87，flash 档为 $0.0028 / $0.14 / $0.28，ultraspeed 为 $0.036 / $4.35 / $8.7。批量推理只支持 `mimo-v2.6-pro` 和 `mimo-v2.6-flash`，价格是实时推理的一半 [8]。

### 订阅套餐：Token Plan（个人版 / 团队版）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 固定月费或年费，额度以 Credits 计，各模型按不同折算系数扣减（见「限流与档位」）[9] |
| OpenAI 兼容 Base URL | 中国集群 `https://token-plan-cn.xiaomimimo.com/v1`，新加坡集群 `https://token-plan-sgp.xiaomimimo.com/v1`，欧洲集群 `https://token-plan-ams.xiaomimimo.com/v1`。原文：「Base URL 以 Token Plan 页面展示为准」[10] |
| Anthropic 兼容 Base URL | 把上面三个地址的 `/v1` 换成 `/anthropic` [10] |
| 鉴权方式 | 同按量 API。个人版 Key 格式为 `tp-xxxxx`，团队版为 `ttp-xxxxx` [1] |
| Key 获取页 | 订阅后在 https://platform.xiaomimimo.com/#/console/plan-manage 获取。团队成员在团队空间「我的席位」里获取 [1][10] |
| Key 是否与按量 API 通用 | 不通用，见上表 [12] |
| 使用限制 | 原文：「Token Plan 套餐额度仅可在编程工具（如 OpenClaw、OpenCode 等）中使用，禁止以 API 调用的形式用于自动化脚本、自定义应用程序后端等明显非 Coding 场景的请求行为。若使用套餐对应的 API Key 进行超出许可范围的调用，将被视为违规或滥用行为，平台有权对相关订阅采取暂停服务、封禁 API Key 等处理措施。」个人版和团队版的条款相同 [10] |
| 其他 | 套餐一经购买不退款 [10][13]。支持首购 88 折、连续包年 88 折，北京时间 0:00–8:00 按 0.8 倍扣 Credits [9] |

Xiaomi MiMo Desktop 会员是另一套订阅。原文：「会员权益及额度仅限 Desktop 内使用，不包含用于其他工具的 Token Plan 套餐额度」[14]。MiMo Claw 订阅（首月 ¥14.9，之后 ¥19.9/月）是官方新闻里为 MiMo Claw 产品推出的订阅 [19]，没查到它能给第三方 API 调用。这两项都与 DocFlow 无关。

## 模型

| 模型 ID | 类型 | 上下文 | 最大输出 | temperature 范围 | 默认值 | 官方推荐值 | 思考开关参数 | 其他采样限制 | 可在哪用 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mimo-v2.6-pro` | 混合思考，默认开启 | 1M | 128K。`max_completion_tokens` 可取 1–131072，默认 131072 | [0, 1.5] | 1.0 | 1.0（见表下说明） | `"thinking": {"type": "enabled" \| "disabled"}`，默认 `enabled` | 思考模式下自定义的 temperature 和 top_p 不生效，服务端强制用 1.0 和 0.95（不报错）。top_p 可取 [0.01, 1.0]，默认 0.95。frequency_penalty 和 presence_penalty 可取 [-2, 2]，默认 0。stop 最多 4 个。`tool_choice` 只支持 `auto` | 按量、Token Plan | [2][3][5][6] |
| `mimo-v2.6-flash` | 同上 | 1M | 同上 | [0, 1.5] | 1.0 | 1.0 | 同上 | 同上 | 按量、Token Plan | [2][3][5][6] |
| `mimo-v2.6-pro-ultraspeed` | 同上。官方称推理速度最高是 V2.6-Pro 的 20 倍 | 1M | 同上 | [0, 1.5] | 1.0 | 1.0 | 同上 | 同上 | 按量（限流需单独洽谈，见下文）。Token Plan 各档都不含 | [2][3][14][16] |
| `mimo-v2.5-pro` | 同上。**2026-10-21 10:00 下线** | 1M | 128K，`max_completion_tokens` 默认 131072 | [0, 1.5] | 1.0 | 1.0 | 同上 | 同上 | 按量、Token Plan 个人版 | [2][3][5][15] |
| `mimo-v2.5` | 同上。**2026-10-21 10:00 下线** | 1M | 128K，但 `max_completion_tokens` 默认只有 32768 | [0, 1.5] | 1.0 | 1.0 | 同上 | 同上 | 按量、Token Plan 个人版 | [2][3][5][15] |

- **官方推荐值的出处**：「模型超参」页说思考模式下强制采用「其推荐默认值 1.0 和 0.95」[3]。V2.6 模型卡原文为「Recommended sampling: `temperature=1.0`, `top_p=0.95`」[17]。官方**没有按场景给温度档位**，也没有翻译专用的推荐值。超参页只有一句定性描述：「较高的值（如 0.8）会使输出更加随机，而较低的值（如 0.2）会使输出更具确定性」[3]。
- **非思考模式才能自定义温度**。思考模式下传了 temperature 和 top_p 也不报错，只是被忽略 [3][6]。
- **输出上限参数**：Chat Completions 文档只列了 `max_completion_tokens`，它包括推理 token [5]。`max_tokens` 只出现在 Anthropic 格式里，OpenAI 格式下是否接受 `max_tokens` **未查到**。
- **已下线的旧型号**：`mimo-v2-pro`、`mimo-v2-omni`、`mimo-v2-flash` 于 2026-06-30 下线，此前已被路由到 V2.5 系列。当时 `mimo-v2-flash` 的默认值是 thinking=disabled、temperature=0.3，这组默认值现已不适用 [15]。
- `tool_choice` 传入非 `auto` 的值时，后端会移除该字段 [5]，与翻译无关。
- 官方「强烈推荐」一段自报身份的系统提示词（「你是MiMo……」）[1]。DocFlow 用自己的翻译提示词，影响**未查到**。

## 限流与档位

### 按量 API

- **档位**：没有分档。每个账号每个模型都是同一套配额。控制台有「申请提升限速」入口，要填行业、场景以及期望的 TPM 和 RPM，每天只能提交一次（见控制台前端文案 [20]）。
- **计算口径**：原文：「RPM……计算范围为调用同一模型时，单个账号下所有 API Key 的请求总数之和」。TPM 的口径相同 [2][7]。
- **并发**：原文：「平台对每个账号设有模型并发上限，服务器负载较高时可能出现响应延迟或 429 报错」。**具体并发数未公开**，没查到 [2][7]。
- **RPD**：没有列出，未查到。

| 模型 | RPM | TPM | 来源 |
| --- | --- | --- | --- |
| `mimo-v2.6-pro` | 100 | 10M | [7] |
| `mimo-v2.6-flash` | 100 | 10M | [7] |
| `mimo-v2.6-pro-ultraspeed` | 「定制服务，请联系我们」 | 同左 | [2][7] |
| `mimo-v2.5-pro`（即将下线） | 100 | 10M | [7] |
| `mimo-v2.5`（即将下线） | 100 | 10M | [7] |

- **超限返回**：错误码页写的是「429 - 请求超限｜请求过于频繁，或者 Token Plan 的额度耗尽｜实现指数退避和重试逻辑，或降低请求频率」[4]。429 的响应正文原文和 `Retry-After` 头**未查到**。无 Key 探测时，401 的正文是 `{"error":{"message":"Invalid API Key","param":"Please provide valid API Key","code":"401","type":"invalid_key"}}`（2026-09-23 实测）。
- **其他相关状态码**：402「余额不足」；403「服务暂不支持当前地区，或 API Key 被风控」；421「内容拦截」；503「服务器负载过高」[4]。

### 订阅套餐（Token Plan）

个人版月付价格和额度 [9][10]：

| 档位 | 月价（国内 / 海外） | 每月 Credits | 年付价（国内 / 海外） | 每年 Credits |
| --- | --- | --- | --- | --- |
| Lite | ¥39 / $6 | 41 亿 | ¥411.84 / $63.36 | 492 亿 |
| Standard | ¥99 / $16 | 110 亿 | ¥1045.44 / $168.96 | 1320 亿 |
| Pro | ¥329 / $50 | 380 亿 | ¥3474.24 / $528.00 | 4560 亿 |
| Max | ¥659 / $100 | 820 亿 | ¥6959.04 / $1056.00 | 9840 亿 |

团队版没有 Lite 档。Standard、Pro、Max 按席位计价：¥99 / ¥329 / ¥659 每席每月，每席每月额度与个人版同档相同 [9]。

每个 token 扣多少 Credits（个人版和团队版相同）[9][13]：

| 模型 | 输入·命中缓存 | 输入·未命中缓存 | 输出 |
| --- | --- | --- | --- |
| `mimo-v2.6-pro`、`mimo-v2.5-pro` | 2.5 | 300 | 600 |
| `mimo-v2.6-flash`、`mimo-v2.5` | 2 | 100 | 200 |

- **可用模型**：`mimo-v2.6-pro`、`mimo-v2.6-flash`，外加 ASR 和 TTS 模型。个人版额外包含 `mimo-v2.5-pro` 和 `mimo-v2.5`。**不含 ultraspeed** [9][14]。
- **并发和 RPM**：套餐文档**没有给出**并发、RPM 或 TPM 数值，未查到。
- **超额行为**：原文：「当套餐的每月总额度耗尽，系统将停止服务，不会继续消耗您的赠金或账户余额」。之后只能升级套餐或改用按量 API。团队版里，某个席位额度用完只停该席位 [9][13]。额度用完时返回 429 [4]。

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | 小米 MiMo | — |
| Base URL（按量） | `https://api.xiaomimimo.com/v1`。拼接后是 `…/v1/chat/completions` 和 `…/v1/models`，两个地址都有官方文档。2026-09-23 无 Key 探测都返回 401，说明端点存在 | [1][5] |
| Base URL（套餐） | **不建议提供 Token Plan 预设**。条款禁止把套餐用于「自定义应用程序后端等明显非 Coding 场景」，PDF 翻译属于非 Coding 场景，有被封 Key 的风险。如果主会话仍要收录，地址是 `https://token-plan-cn.xiaomimimo.com/v1`，另有 `-sgp`、`-ams` 两个集群，界面上必须提示这一条款 | [10] |
| Key 获取页 | https://platform.xiaomimimo.com/#/console/api-keys | [1] |
| 新账号安全并发数 | **4**。RPM 上限是 100/模型/账号，但官方明说还有一个不公开的「模型并发上限」，负载高时也会回 429。4 路并发、单请求 10–30 s 时约为 8–24 RPM，远低于 100。之后交给 DocFlow 的 429 自适应降并发 | [2][7] |
| 默认翻译温度 | `mimo-v2.6-flash` 和 `mimo-v2.6-pro` 都用 **1.0**，并且**必须同时关闭思考**，否则温度被忽略。1.0 是官方唯一给出的推荐值（超参页的推荐默认值，V2.6 模型卡的 Recommended sampling）。官方没有翻译专用档位 | [3][17] |
| 是否默认关闭思考 | **默认关闭**。在服务商级 `extraBody` 写 `{"thinking": {"type": "disabled"}, "temperature": 1.0}`。现役和即将下线的模型默认都开启思考，开着会多花推理 token、变慢，温度也不可调 | [5][6] |
| 首选翻译模型 | **`mimo-v2.6-flash`**（非思考）。国内价 ¥1 / ¥2 每百万 tokens，是 pro 的三分之一；官方定位是「专业办公中的高频调用与规模化任务」 | [2][8] |
| 输出上限 | 保持 DocFlow 默认（maxOutputTokens=0，即不传），服务端默认的 `max_completion_tokens` 为 131072。如果用户手动设置输出上限，DocFlow 会发 `max_tokens`，但 MiMo 的 OpenAI 格式文档只列了 `max_completion_tokens`，需要实测 | [5] |

风险提示：

1. **Token Plan 条款**：只能在编程工具里用，违规会被暂停服务或封禁 Key [10]。
2. **型号更替快**：`mimo-v2.5-pro` 和 `mimo-v2.5` 在 2026-10-21 下线，且没有替换路由 [15]。预设不要写死模型 ID，现有规划本来就不带默认模型，保持即可。
3. **并发上限不透明**：只公布了 RPM 和 TPM [2][7]。
4. **内容审核**：译文或原文触发审核会返回 421 [4]。DocFlow 的错误分类里 421 属于「其他 4xx → rejected」，建议在中文提示里说明原因可能是内容被拦截。
5. **ultraspeed**：限流要单独洽谈，价格是 pro 的 10 倍，不适合作为默认模型 [7][8]。

## 来源

页面为前端渲染，中文正文取自同站点加载的中文文档数据；英文全文另见 [18]。

1. [首次调用 API](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)（2026-09-23 访问）
2. [模型列表](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)（2026-09-23 访问）
3. [模型超参](https://mimo.mi.com/docs/zh-CN/api/guidance/model-hyperparameters)（2026-09-23 访问）
4. [错误码](https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes)（2026-09-23 访问）
5. [OpenAI Chat Completions API 兼容](https://mimo.mi.com/docs/zh-CN/api/chat/openai-api)（2026-09-23 访问）
6. [深度思考](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking)（2026-09-23 访问）
7. [速率限制](https://mimo.mi.com/docs/zh-CN/api/guidance/rate-limit)（2026-09-23 访问）
8. [API 定价（按量付费）](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)（2026-09-23 访问）
9. [Token Plan 定价](https://mimo.mi.com/docs/zh-CN/price/token-plan)（2026-09-23 访问）
10. [Token Plan 个人版](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/subscription)（含套餐使用条款、集群 Base URL；团队版页 https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/team 条款相同）；[AI 工具总览](https://mimo.mi.com/docs/zh-CN/tokenplan/integration/tools-overview)（2026-09-23 访问）
11. [常见问题 · 账号与认证](https://mimo.mi.com/docs/zh-CN/quick-start/faq/account)（2026-09-23 访问）
12. [常见问题 · API 接入](https://mimo.mi.com/docs/zh-CN/quick-start/faq/api-integration)（2026-09-23 访问）
13. [常见问题 · Token Plan 用量与额度](https://mimo.mi.com/docs/zh-CN/quick-start/faq/token-plan/Usage%26Quota)、[有效期与到期](https://mimo.mi.com/docs/zh-CN/quick-start/faq/token-plan/Validity%26Expiry)（2026-09-23 访问）
14. [Token Plan 与 Desktop 会员说明](https://mimo.mi.com/docs/zh-CN/quick-start/faq/token-plan/desktop-guide)（2026-09-23 访问）
15. [模型下线](https://mimo.mi.com/docs/zh-CN/updates/deprecate)（2026-09-23 访问）
16. [模型发布（更新日志）](https://mimo.mi.com/docs/zh-CN/updates/model)（2026-09-23 访问）
17. [MiMo-V2.6-Flash-RL 模型卡](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL)、[MiMo-V2.6-Pro-RL 模型卡](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL)（小米官方 Hugging Face 组织；2026-09-23 访问）
18. [Xiaomi MiMo API 文档英文全文 llms-full.txt](https://mimo.mi.com/llms-full.txt)（含 V2.6 发布新闻；2026-09-23 访问）
19. [Xiaomi MiMo Claw 正式发布（新闻）](https://mimo.mi.com/static/docs/news/latest/mimoclaw.md)（2026-09-23 访问）
20. [Xiaomi MiMo 开放平台控制台](https://platform.xiaomimimo.com/)（前端文案中的「当前限速」「申请提升限速」表单；2026-09-23 访问）
