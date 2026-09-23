# 深度求索（DeepSeek）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 现役对话模型两款：`deepseek-flash`（DeepSeek-V4.1-Flash，2026-09-10 上线）和 `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）。两款都是 1M 上下文的混合思考模型，**默认开启思考**。[2][12]
- 只有一个开放平台 platform.deepseek.com，国内外共用。中英文文档给的是同一个 Base URL，中文定价页用人民币标价，英文定价页用美元标价。没有单独的国际站。[1][2][3]
- **没有订阅套餐**。官方 FAQ 的原话是「目前我们实行统一的 API 收费标准，暂无分级套餐」[15]。定价页只有按 token 扣费，从充值余额或赠送余额里扣 [2]。没查到任何 Coding Plan、Token Plan 或会员形式的 API 套餐。

## 接入方式

### 按量 API（platform.deepseek.com，国内外同一平台）

| 项目                    | 内容                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 计费方式                | 按 token 计费，输入分缓存命中和未命中，输出单独计价。实行峰谷定价：北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00 为高峰，其余时段（含周末和法定节假日全天）为空闲，空闲价是高峰价的一半。英文页写作 UTC 01:00–04:00、06:00–10:00。[2][3] |
| OpenAI 兼容 Base URL    | `https://api.deepseek.com`。官方写法**没有 `/v1` 这一级**：对话接口是 `POST /chat/completions`，模型列表是 `GET /models`。[1][8][10]                                                                                                                   |
| Anthropic 兼容 Base URL | `https://api.deepseek.com/anthropic` [1][9]                                                                                                                                                                                                            |
| 鉴权方式                | OpenAI 格式用 `Authorization: Bearer ${DEEPSEEK_API_KEY}`；Anthropic 格式「x-api-key：完全支持」[1][9]                                                                                                                                                 |
| Key 获取页              | https://platform.deepseek.com/api_keys [15][17]                                                                                                                                                                                                        |
| Key 是否与按量 API 通用 | 不适用，没有订阅套餐。并发按账号计算，与 Key 无关。[5]                                                                                                                                                                                                 |
| 使用限制                | 服务协议允许把 API 集成进面向内部或终端用户的应用，原文：「特别适用于您作为个人或企业开发者……开发面向组织内部或终端用户的应用程序、服务或工具的活动」[16]。没看到限定调用工具类型的条款。                                                              |
| 充值                    | 中文 FAQ：「在线充值：完成实名认证后，您可以在「充值」页面使用支付宝/微信进行在线充值」；「您的充值余额永久有效，不会过期」；「未消费金额支持退款」[15]                                                                                                |

价格（每百万 tokens，括号内为英文页美元价）[2][3]：

| 模型              | 输入·缓存命中 空闲 / 高峰        | 输入·缓存未命中 空闲 / 高峰  | 输出 空闲 / 高峰               |
| ----------------- | -------------------------------- | ---------------------------- | ------------------------------ |
| `deepseek-flash`  | ¥0.02 / ¥0.04（$0.003 / $0.006） | ¥1 / ¥2（$0.15 / $0.3）      | ¥4 / ¥8（$0.6 / $1.2）         |
| `deepseek-v4-pro` | ¥0.15 / ¥0.30（$0.022 / $0.044） | ¥4.5 / ¥9.0（$0.66 / $1.32） | ¥13.5 / ¥27.0（$1.98 / $3.96） |

### 订阅套餐

无。官方 FAQ 在「是否有限速更高的套餐」下的回答：「目前我们实行统一的 API 收费标准，暂无分级套餐。……若您有更高的并发需求，可提交账号扩容申请工单，我们将根据您实际的业务需求匹配合适的并发量，扩容并不增加额外的费用。」[15]

## 模型

| 模型 ID           | 类型               | 上下文 | 最大输出                                                                                                        | temperature 范围        | 默认值 | 官方推荐值                       | 思考开关参数                                                                                                                                              | 其他采样限制                                                                                                                                                                                                        | 可在哪用 | 来源          |
| ----------------- | ------------------ | ------ | --------------------------------------------------------------------------------------------------------------- | ----------------------- | ------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| `deepseek-flash`  | 混合思考，默认思考 | 1M     | 384K。`max_tokens` 可取 1–393216；不传时非思考模式默认 8K，思考模式默认 64K，`reasoning_effort=max` 时默认 128K | 0–2，只在非思考模式生效 | 1.0    | 按场景给档位，翻译 1.3（见下表） | 关闭用 `"thinking": {"type": "disabled"}` 或 `"reasoning_effort": "none"`；默认 `enabled`。强度用 `reasoning_effort`：`low` / `high` / `max`，默认 `high` | `top_p` 在非思考模式恒为 1.0，传值被忽略；在思考模式有效范围 0.95–1.0，低于 0.95 按 0.95 处理。`presence_penalty` / `frequency_penalty` 已弃用，传了也没有效果。官方不建议同时改 temperature 和 top_p。支持图像理解 | 按量 API | [2][7][8]     |
| `deepseek-v4-pro` | 混合思考，默认思考 | 1M     | 同上                                                                                                            | 同上                    | 1.0    | 同上                             | 同上                                                                                                                                                      | 同上，但不支持图像理解                                                                                                                                                                                              | 按量 API | [2][7][8][11] |

- **旧模型名**：`deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp`「仍可调用，但对应模型已下线，请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费」，公告里的说法是「将被暂时路由」，没给截止日期。[2][12]
- **已停用**：`deepseek-chat` 和 `deepseek-reasoner`。2026-04-24 的公告说「将于三个月后（2026-07-24）停止使用」，现行文档已不再列出这两个名字。[11][13]
- **`deepseek-v4-pro` 的去留**：2026-09-10 的新闻稿说计划 9 月 14 日 12:00 后把 `deepseek-v4-pro` 的请求全部路由到 V4.1 Flash [12]。更新日志随后改口：「决定在 2026 年 9 月 14 日之后继续提供 DeepSeek V4 Pro 的 API 调用服务，计费方式保持不变；如有变动，我们将另行通知」[11]。截至查证日，定价页仍列出该模型 [2]，没有明确的下线日期。

### 官方按场景的温度档位（原样摘录）

「Temperature 设置」页原文：「temperature 参数默认为 1.0。我们建议您根据如下表格，按使用场景设置 temperature。」[4]

| 场景                | 温度                                |
| ------------------- | ----------------------------------- |
| 代码生成/数学解题   | 0.0                                 |
| 数据抽取/分析       | 1.0                                 |
| 通用对话            | 1.3                                 |
| **翻译**            | **1.3**（DocFlow 翻译场景取这一档） |
| 创意类写作/诗歌创作 | 1.5                                 |

英文版同表：Coding / Math 0.0；Data Cleaning / Data Analysis 1.0；General Conversation 1.3；Translation 1.3；Creative Writing / Poetry 1.5。[4]

这张表不区分模型。由于思考模式下 temperature 不生效（见下节），**只有关闭思考时这张表才有意义**。

### 思考模式对采样参数的处理（忽略，不报错）

- 原文：「思考模式不支持 temperature、presence_penalty、frequency_penalty 参数。请注意，为了兼容已有软件，设置参数不会报错，但也不会生效。」[7]
- API 参考里 temperature 的说明写的是「采样温度，介于 0 和 2 之间……思考模式下不生效」，默认值为 1。[8]
- Anthropic 格式：「temperature：完全支持（范围 [0.0 ~ 2.0]）」；「top_p：仅思考模式下生效（下限为 0.95）；非思考模式下恒为 1.0」；「top_k：忽略」；「thinking：支持（budget_tokens 被忽略）」；「output_config：仅支持 effort」。[9]
- 官方公布基准成绩时用的设置是「max 档位，topp=0.95，temperature=1.0」。这是评测配置，不是翻译场景的推荐值。[14]

### 思考开关与强度参数

「思考模式默认打开，且 effort 默认为 high」[7]：

| 用途     | OpenAI 格式（Chat Completions）                                                            | Anthropic 格式                                  | Responses API 格式                                              |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------- |
| 思考开关 | `{"thinking": {"type": "enabled/disabled"}}`；也可用 `"reasoning_effort": "none"` 关闭 [8] | `{"thinking": {"type": "enabled/disabled"}}`    | `{"reasoning": {"effort": "none/low/high/max"}}`，none 表示关闭 |
| 思考强度 | `{"reasoning_effort": "low/high/max"}`                                                     | `{"output_config": {"effort": "low/high/max"}}` | 同上                                                            |

- 用 OpenAI SDK 时，`thinking` 要放进 `extra_body`。[7]
- effort 取值会被映射：minimal→low、low→low、medium→high、high→high、xhigh→high、max→max、ultra→max。[7]

## 限流与档位

### 按量 API

- **档位**：没有档位。官方 FAQ 说「暂无分级套餐」，并说明个人认证和企业认证账号「在用户权益和产品功能上目前无差异」[15]。限速页写的是「对每个账号」都适用同一张并发表，没有按充值额或账号类型区分，所以新账号也用这张表 [5]。
- **并发上限（账号级，与 API Key 无关）** [2][5]：

  | 模型              | 并发限制 |
  | ----------------- | -------- |
  | `deepseek-flash`  | 2500     |
  | `deepseek-v4-pro` | 500      |

  原文：「一个请求从发出后，到模型响应完成之前记为一个并发」；「并发限制以账号粒度计，与 API Key 无关」；「超过并发限度时，您会收到 HTTP 429 错误码」。[5]

- **申请扩容后的账号**：「我们会限制您账号下的总并发，同时我们会对每个您传入的 user_id 进行并发限制（空 id 为一个特殊的 user_id）。对每个 user_id，deepseek-flash 的并发限制为 2500，deepseek-v4-pro 的并发限制为 500。」[5]
- **RPM / TPM / RPD**：**没查到具体数值**。错误码页只写到 429 的原因是「请求速率（TPM 或 RPM）达到上限」。[6]
- **超限时的返回**：HTTP 429，错误码页写的是「429 - 请求速率达到上限｜原因：请求速率（TPM 或 RPM）达到上限｜解决方法：请合理规划您的请求速率。」[6]。响应正文原文**没查到**，是否带 `Retry-After` 也**没查到**。相关的其他状态码：402「账号余额不足」、503「服务器负载过高」、500「服务器内部故障」[6]。另外 `finish_reason` 可能是 `insufficient_system_resource`，意思是「系统推理资源不足，生成被打断」[8]。
- **排队保活**：请求等待期间，「非流式请求：持续返回空行；流式请求：持续返回 SSE keep-alive 注释（: keep-alive）」；「如果 10 分钟后，请求仍未开始推理，服务器将关闭连接」。[5]

### 订阅套餐

无，理由见前文。[15]

## 对 DocFlow 的建议

| 项               | 建议                                                                                                                                                                                                                   | 依据                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 显示名           | DeepSeek                                                                                                                                                                                                               | —                                                                                                                |
| Base URL（按量） | `https://api.deepseek.com`。建议把 `docs/plan/04-translation.md` 预设表里的 `https://api.deepseek.com/v1` 改成官方写法。DocFlow 拼接后得到 `https://api.deepseek.com/chat/completions` 和 `…/models`，与官方示例一致。 | [1][10]。现行文档已不提 `/v1`，`/v1` 是否仍然可用**没查到**，不要依赖。                                          |
| Base URL（套餐） | 无                                                                                                                                                                                                                     | [15]                                                                                                             |
| Key 获取页       | https://platform.deepseek.com/api_keys                                                                                                                                                                                 | [17]                                                                                                             |
| 新账号安全并发数 | **100**，沿用 DocFlow 默认值。账号级并发上限为 flash 2500、v4-pro 500，与充值额无关，新账号也一样，100 只占 v4-pro 上限的 1/5。RPM/TPM 没公开，429 时靠 DocFlow 的自适应减半兜底。                                     | [5][6]                                                                                                           |
| 默认翻译温度     | 两个模型都用 **1.3**，前提是同时关闭思考，否则温度会被忽略。                                                                                                                                                           | [4][7]                                                                                                           |
| 是否默认关闭思考 | **默认关闭**。两款模型行为一致，可以写在服务商级 `extraBody`：`{"thinking": {"type": "disabled"}, "temperature": 1.3}`。                                                                                               | [7][8]                                                                                                           |
| 首选翻译模型     | **`deepseek-flash`**（非思考）                                                                                                                                                                                         | 官方称「V4.1 Flash 在性能、费用、速度、总用时等各项指标上已全面超越 V4 Pro」[12]；输入价约为 V4 Pro 的 1/4.5 [2] |
| max_tokens       | 可以不设，非思考模式默认 8K。遇到 `finish_reason=length` 再调大，上限 393216。                                                                                                                                         | [8]                                                                                                              |

风险提示：

1. **思考默认开启**。不显式关闭时，temperature 不生效（也不报错），模型还会先生成一段 `reasoning_content`，变慢也多花钱。思维链在单独的 `reasoning_content` 字段返回，不混进 `content`，所以解析不受影响，只是要为它付费。[7][8]
2. **峰谷定价**。北京时间工作日 9:00–12:00、14:00–18:00 的价格是空闲时段的两倍，可以在界面上提示用户。[2]
3. **模型名在变**：`deepseek-chat` 和 `deepseek-reasoner` 已停用；`deepseek-v4-flash` 只是「暂时路由」；`deepseek-v4-pro` 的去留反复过一次。预设里不要写死模型 ID，现有规划本来就不带默认模型，保持即可。[2][11][12][13]
4. **RPM/TPM 没公开**，429 没有写明重试间隔。需要依赖 DocFlow 的 429 自适应降并发和默认 5 s 退避。[6]
5. **非流式请求在排队时会先收到空行**，最长等 10 分钟。DocFlow 用 `stream: false` 解析 JSON 时要能容忍前导空白（`JSON.parse` 本身能跳过空白），15 分钟超时也足够覆盖。[5]

## 来源

1. [首次调用 API（DeepSeek API 文档）](https://api-docs.deepseek.com/zh-cn/)（2026-09-23 访问）
2. [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（2026-09-23 访问）
3. [Models & Pricing（英文版）](https://api-docs.deepseek.com/quick_start/pricing)（2026-09-23 访问）
4. [Temperature 设置](https://api-docs.deepseek.com/zh-cn/quick_start/parameter_settings)，英文版 [The Temperature Parameter](https://api-docs.deepseek.com/quick_start/parameter_settings)（2026-09-23 访问）
5. [限速与隔离](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit)（2026-09-23 访问）
6. [错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes)（2026-09-23 访问）
7. [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)（2026-09-23 访问）
8. [Chat Completions API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)（2026-09-23 访问）
9. [使用 Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)（2026-09-23 访问）
10. [获取模型列表](https://api-docs.deepseek.com/zh-cn/api/list-models)（2026-09-23 访问）
11. [更新日志](https://api-docs.deepseek.com/zh-cn/updates)（2026-09-23 访问）
12. [DeepSeek-V4.1-Flash 发布 2026/09/10](https://api-docs.deepseek.com/zh-cn/news/news260910)（2026-09-23 访问）
13. [DeepSeek-V4 预览版发布 2026/04/24](https://api-docs.deepseek.com/zh-cn/news/news260424)（2026-09-23 访问）
14. [DeepSeek-V4-Pro 正式版上线 2026/08/13](https://api-docs.deepseek.com/zh-cn/news/news260813)（2026-09-23 访问）
15. [DeepSeek 常见问题 · API 分类](https://static.deepseek.com/faq/index.html?lang=zh#/category/4)（由 https://api-docs.deepseek.com/zh-cn/faq 跳转；2026-09-23 访问）
16. [DeepSeek 开放平台服务协议（2026-04-29 生效）](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html)（2026-09-23 访问）
17. [DeepSeek 开放平台 API keys 页](https://platform.deepseek.com/api_keys)（2026-09-23 访问）
