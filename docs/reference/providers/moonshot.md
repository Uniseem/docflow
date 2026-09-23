# 月之暗面 Kimi（Moonshot AI）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- **开放平台（按量付费）**：分国内站和国际站。国内站 platform.kimi.com（原 platform.moonshot.cn，301 跳转），国际站 platform.kimi.ai（原 platform.moonshot.ai，301 跳转）。两站的账户、余额和 API Key 完全独立 [15][25]。API 域名没有变，仍是 `api.moonshot.cn` 和 `api.moonshot.ai` [2][24]。官方原话：「Kimi API 开放平台是按量计费模式、无订阅制方案」[18]。
- **现役文本对话模型**（三个系列，四个型号，都是多模态）[3]：
  - `kimi-k3`：旗舰，始终思考，1M 上下文；
  - `kimi-k2.7-code` / `kimi-k2.7-code-highspeed`：编程专用，始终思考，256K；
  - `kimi-k2.6`：通用，思考可以关闭，256K。

  `moonshot-v1` 全系、`kimi-k2` 系列、`kimi-k2.5`、`kimi-latest` 都已下线 [3][19]。

- **订阅套餐**属于 Kimi 会员体系：
  - 官方编程服务叫 **Kimi Code**，是「Kimi 会员权益中面向开发者的智能编程服务」[31]。落地页称 **Kimi Code Plan** [41]，第三方工具里的供应商名是 **Kimi For Coding** [36]。
  - 新档位为 **Go / Plus / Pro / Max**，旧档位为 Andante / Moderato / Allegretto / Allegro [31][33]。
  - Kimi Code 和开放平台是两套系统，Key、Base URL、余额都不通用 [16][33]。
  - 社区倡议里出现过「Token Plan」一词 [32]，但没查到叫 Token Plan 的独立产品。

## 接入方式

### 按量 API · 国内站（platform.kimi.com）

| 项目                    | 内容                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式                | 按 token 计费，预充值余额扣费。输入分缓存命中和未命中，K3 另收缓存写入费 [12]。2026 年 9 月起，「账户消耗按现金、代金券各 50% 的统一比例扣除」[19]。                                         |
| OpenAI 兼容 Base URL    | `https://api.moonshot.cn/v1`。对话接口 `/chat/completions`，模型列表 `/models`。[2]                                                                                                          |
| Anthropic 兼容 Base URL | `https://api.moonshot.cn/anthropic`，接口 `/v1/messages`。[2][6]                                                                                                                             |
| 鉴权方式                | `Authorization: Bearer $MOONSHOT_API_KEY`。Messages API 同样用 Bearer。[2][6]                                                                                                                |
| Key 获取页              | https://platform.kimi.com/console/api-keys（旧地址 platform.moonshot.cn/console/api-keys 会 301 到这里）[1]                                                                                  |
| Key 是否通用            | 只能用于国内站端点。原文：「`platform.kimi.com`（中国站）与 `platform.kimi.ai`（国际站）的账户、余额和 API Key 完全独立，混用会返回 401」[15]。与 Kimi Code 的 Key 也不通用 [16]。           |
| 使用门槛                | 个人或企业认证后「会为您赠送 15 元代金券」，但这张券不能用于 K3 [17]。K3「在开放平台完成充值（最低充值金额 10 元）后即可解锁调用」[7]。累计充值额决定用户等级（见限流一节）[13]。            |
| 使用限制                | 服务协议：「我们许可您以调用接口的形式使用本服务……本服务仅供您内部使用或向最终用户提供服务」；账号「不得以任何形式……转让、出借、出租或提供给他人使用」[21]。没看到限定调用方工具类型的条款。 |

### 按量 API · 国际站（platform.kimi.ai）

| 项目                    | 内容                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式                | 按 token 计费，美元标价，「Prices exclude applicable taxes」[23]                                                                                                                                      |
| OpenAI 兼容 Base URL    | `https://api.moonshot.ai/v1` [24]                                                                                                                                                                     |
| Anthropic 兼容 Base URL | `https://api.moonshot.ai/anthropic` [24]                                                                                                                                                              |
| 鉴权方式                | `Authorization: Bearer $MOONSHOT_API_KEY` [24]                                                                                                                                                        |
| Key 获取页              | https://platform.kimi.ai/console/api-keys [24]                                                                                                                                                        |
| Key 是否通用            | 原文：「Keys issued on `platform.kimi.ai` are independent from keys issued on other regional Kimi platforms. Mixing keys across platforms returns 401.」[25]                                          |
| 使用门槛                | 原文：「you need to recharge at least $1 to start using, and when your cumulative recharge reaches $5, you will receive a $5 voucher」[22]；K3「unlocked after a successful top-up (minimum $1)」[26] |
| 使用限制                | 同国内站，未见限定调用方的条款                                                                                                                                                                        |

### 订阅套餐 · Kimi Code（随 Kimi 会员提供，国内与海外）

| 项目                    | 内容                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式                | Kimi 会员包月或包年。Kimi Code「随 Kimi 会员订阅一同提供，与 Kimi 会员共享同一套额度」。额度用完后可以开「加油包（Extra Usage）」按量扣费。[31][38]                                                                                                                                                                                                                        |
| OpenAI 兼容 Base URL    | 国内 `https://api.kimi.com/coding/v1`；海外 `https://api.kimi.ai/coding/v1`。服务端也支持 Responses API。[30][43]                                                                                                                                                                                                                                                          |
| Anthropic 兼容 Base URL | 国内 `https://api.kimi.com/coding/`；海外 `https://api.kimi.ai/coding/` [30]                                                                                                                                                                                                                                                                                               |
| 鉴权方式                | Kimi Code 控制台创建的 API Key，「最多 5 个，仅创建时显示一次」[36]。Claude Code 示例用 `ANTHROPIC_API_KEY` 传 Key [42]，Codex 示例用 `env_key = "KIMI_API_KEY"` [43]。OpenAI 兼容协议下具体用哪个请求头，文档没有单列，**没查到**。                                                                                                                                       |
| Key 获取页              | Kimi Code 控制台 https://www.kimi.com/code/console [31]。海外控制台地址文档没有单列，**没查到**。                                                                                                                                                                                                                                                                          |
| Key 是否与按量 API 通用 | **不通用**。原文：「Kimi Code 和 Kimi 开放平台 是两套独立系统，Key 和 Base URL 均不通用」[33]；「Kimi 会员（订阅制）的权益不会转换为开放平台余额」[16]。                                                                                                                                                                                                                   |
| 使用限制                | 「Kimi Code 订阅仅限个人交互式使用场景。通过脚本批量执行、数据标注等非交互式方式使用，超出了正常使用范畴。」[32]<br>「不伪造或篡改客户端身份信息」[32]<br>「本权益仅用于个人开发，非用于企业开发场景」[37]<br>违规的处理方式：「根据情节进行限制并发等处理。你会收到 You've reached your concurrent request limit 报错」，经由非官方渠道获取服务的「可能面临封号处理」[32] |

## 模型

### 开放平台（按量 API，国内站与国际站相同）

| 模型 ID                    | 类型                                         | 上下文    | 最大输出                                                    | temperature 范围                           | 默认值                | 官方推荐值                            | 思考开关参数                                                                                                               | 其他采样限制                                                                                                                                                               | 可在哪用 | 来源          |
| -------------------------- | -------------------------------------------- | --------- | ----------------------------------------------------------- | ------------------------------------------ | --------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| `kimi-k3`                  | 推理，始终思考，不能关闭                     | 1,048,576 | `max_completion_tokens` 默认 131072，最大可设 1048576       | 固定 1.0，不可修改，传其他值报错           | 1.0                   | 「建议不要显式传入」                  | 没有开关（原文：「目前关不了，K3 始终开启思考模式」）。强度用顶层 `reasoning_effort`：`low` / `high` / `max`，默认 `max`   | `top_p` 固定 0.95、`n` 固定 1、`presence_penalty` 和 `frequency_penalty` 固定 0，传其他值都报错。`tool_choice` 支持 auto / none / required。「切换档位会破坏前缀缓存命中」 | 按量 API | [4][5][7][11] |
| `kimi-k2.7-code`           | 推理，始终思考，不能关闭                     | 262,144   | `max_tokens` 默认 32768；上限没有单列（受 256K 上下文约束） | 固定 1.0，传其他值报错                     | 1.0                   | 不要传                                | `thinking` 可以省略；显式设置时只接受 `{"type":"enabled","keep":"all"}`，传 `{"type":"disabled"}` 报错                     | 同上，另外不支持 `tool_choice: "required"`。必须回传历史 `reasoning_content`                                                                                               | 按量 API | [4][5][8]     |
| `kimi-k2.7-code-highspeed` | 同上（和上一行是同一模型，参数约束完全一致） | 262,144   | 同上                                                        | 同上                                       | 同上                  | 同上                                  | 同上                                                                                                                       | 同上。「输出速度约 180 Tokens/s，短上下文场景可达 260 Token/s」                                                                                                            | 按量 API | [3][4][8]     |
| `kimi-k2.6`                | 混合思考，默认思考，可以关闭                 | 262,144   | `max_tokens` 默认 32768；上限没有单列（受 256K 上下文约束） | 固定值：思考 1.0，非思考 0.6，传其他值报错 | 思考 1.0 / 非思考 0.6 | 不要传（原文「无需设置temperature」） | `"thinking": {"type": "disabled"}` 关闭，默认 `{"type": "enabled"}`；`"keep": "all"` 开启保留式思考（默认 `null`，不保留） | `top_p` 0.95、`n` 1、penalty 0，均固定。不支持 `tool_choice: "required"`。思考模式下内置 `$web_search` 不兼容                                                              | 按量 API | [4][9][10]    |

**价格**（每百万 tokens，缓存命中 / 未命中 / 输出）[12][23]：

| 模型                       | 国内站（¥）                                              | 国际站（$）                                      |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| `kimi-k3`                  | 2.00 / 20.00 / 100.00；缓存写入 TTL 5min 20.00、1h 40.00 | 0.30 / 3.00 / 15.00；缓存写入 5min 3.00、1h 6.00 |
| `kimi-k2.7-code`           | 1.30 / 6.50 / 27.00                                      | 0.19 / 0.95 / 4.00                               |
| `kimi-k2.7-code-highspeed` | 2.60 / 13.00 / 54.00                                     | 0.38 / 1.90 / 8.00                               |
| `kimi-k2.6`                | 1.10 / 6.50 / 27.00                                      | 0.16 / 0.95 / 4.00                               |

**已下线模型**：下线后「调用将返回 404 错误」[19]。

| 模型                                                                                                                  | 下线日期   |
| --------------------------------------------------------------------------------------------------------------------- | ---------- |
| `kimi-k2.5`                                                                                                           | 2026-08-31 |
| `moonshot-v1-8k` / `-32k` / `-128k` / `-auto`，以及三个 `-vision-preview`                                             | 2026-08-31 |
| `kimi-k2-0905-preview`、`kimi-k2-0711-preview`、`kimi-k2-turbo-preview`、`kimi-k2-thinking`、`kimi-k2-thinking-turbo` | 2026-05-25 |
| `kimi-latest`                                                                                                         | 2026-01-28 |
| `kimi-thinking-preview`                                                                                               | 2025-11-11 |

现役模型没有公布下线日期。[3][19]

**温度说明**：

- 官方**没有**按场景给出温度档位表。现役 K3 和 K2.x 的温度都是固定值。原文：「表中"固定"表示该参数不可修改：传入其他值会报错，建议不要显式传入。」「建议调用以上模型时不要显式传入 `temperature`。」[4]
- **K2 系列**：旧的 `kimi-k2-*`（含 thinking、turbo）已于 2026-05-25 下线 [3]。现役 K2.x 的温度就是固定值：K2.6 思考 1.0、非思考 0.6；K2.7 Code 1.0 [4][8][9]。另外，「基准测试最佳实践」页（K2.6）写的是：对表中没列出的 benchmark「推荐 temperature = 1.0，stream = true，top_p = 0.95」[20]。
- **翻译场景**：官方没有专门的推荐值。用 K2.6 非思考模式时，实际温度就是固定的 0.6。
- **思考 token 计入 `max_tokens`**：「`reasoning_content` 的 Tokens 数加上 `content` 的 Tokens 数应小于等于 `max_tokens`」；「设置 `max_tokens>=16000` 以避免无法输出完整的 `reasoning_content` 和 `content`」[10]。
- **参数写法**：`max_tokens` 已弃用，改用 `max_completion_tokens` [5]。`thinking` 是 Kimi 的扩展参数，用 OpenAI SDK 时要放进 `extra_body` [2]。

### Kimi Code（订阅；模型 ID 和开放平台不同）

| 模型 ID                     | 模型版本                            | 类型                                           | 上下文窗口                                                       | 思考参数                                        | temperature | 新套餐可用档                  | 老套餐可用档                             | 多模态     | 来源     |
| --------------------------- | ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- | ----------- | ----------------------------- | ---------------------------------------- | ---------- | -------- |
| `k3`                        | K3                                  | 推理（关闭思考后改由 K2.8 Preview 无思考处理） | 1,048,576（面向高档位会员）；Plus / Moderato 调用 `k3` 最高 256K | `reasoning_effort`：low / high / max，默认 high | **没查到**  | Plus 及以上；1M 需 Pro 及以上 | Moderato 及以上；1M 需 Allegretto 及以上 | 图片、视频 | [30][33] |
| `k3-256k`                   | K3                                  | 同上                                           | 仅 262,144（「k3（1M）消耗约为 k3-256k 两倍」）                  | 同上，默认 high                                 | **没查到**  | Plus 及以上                   | Moderato 及以上                          | 仅图片     | [30]     |
| `kimi-for-coding`           | K2.8 Preview（2026-09-11 全量上线） | 推理，effort 可设 none 关闭                    | 1,048,576（「全部会员档位均开放最高 1M 上下文窗口」）            | low / high / max，默认 max                      | **没查到**  | Plus 及以上                   | Andante 及以上                           | 图片、视频 | [30][35] |
| `kimi-for-coding-highspeed` | K2.7 Code HighSpeed                 | 推理（Thinking: ON）                           | 262,144                                                          | 不需要配置                                      | **没查到**  | Pro 及以上                    | Allegretto 及以上                        | 图片、视频 | [30]     |

- 高速版是「6 倍速 3 倍消耗」[30]。最大输出**没查到**。单次请求上限：「total message size N exceeds limit 2097152」（2MB），以及「Your request exceeded model token limit: 262144」[33]。
- 第三方工具传入的 effort 按下表映射 [30]：

  | 传入值                | 实际效果                                      |
  | --------------------- | --------------------------------------------- |
  | null / undefined      | 模型默认值（K3 为 high，K2.8 Preview 为 max） |
  | ultra / max / xhigh   | max                                           |
  | high / medium         | high（推荐）                                  |
  | low / minimum / light | low                                           |
  | none                  | `thinking.type` disabled                      |
  | 其它未知取值          | HTTP 400 请求报错                             |

  「K3 系列与 K2.8 Preview 关闭 thinking 后，请求均由 K2.8 Preview（无思考）处理。」

- 注意：开放平台上 `kimi-k3` 的默认 effort 是 `max` [11]，Kimi Code 上 `k3` 的默认是 `high` [30]，两边不一样。

## 限流与档位

### 按量 API

档位按**累计充值金额**划分（「代金券不计入累计充值总额」），并发、RPM、TPM、TPD **不按模型分列**。原文：「目前我们在所有模型中共享速率限制」；「速率限制是在用户级别而非密钥级别上实施的」。[13][14]

**国内站**（原样抄录）[13]：

| 用户等级 | 累计充值金额 | 并发 | RPM | TPM       | TPD       | 联网搜索 QPS |
| -------- | ------------ | ---- | --- | --------- | --------- | ------------ |
| Tier0    | ¥ 0          | 1    | 3   | 500,000   | 1,500,000 | 1            |
| Tier1    | ¥ 50         | 15   | 100 | 2,000,000 | Unlimited | 3            |
| Tier2    | ¥ 100        | 40   | 100 | 3,000,000 | Unlimited | 5            |
| Tier3    | ¥ 500        | 50   | 200 | 3,000,000 | Unlimited | 10           |
| Tier4    | ¥ 5,000      | 60   | 200 | 4,000,000 | Unlimited | 20           |
| Tier5    | ¥ 20,000     | 100  | 300 | 5,000,000 | Unlimited | 50           |

**国际站**（原样抄录）[22]：

| User Level | Cumulative Recharge Amount | Concurrency | RPM | TPM       | TPD       | Web Search QPS |
| ---------- | -------------------------- | ----------- | --- | --------- | --------- | -------------- |
| Tier0      | $1                         | 1           | 3   | 500,000   | 1,500,000 | 1              |
| Tier1      | $10                        | 15          | 100 | 2,000,000 | Unlimited | 3              |
| Tier2      | $20                        | 40          | 100 | 3,000,000 | Unlimited | 5              |
| Tier3      | $100                       | 50          | 200 | 3,000,000 | Unlimited | 10             |
| Tier4      | $1,000                     | 60          | 200 | 4,000,000 | Unlimited | 20             |
| Tier5      | $3,000                     | 100         | 300 | 5,000,000 | Unlimited | 50             |

- **新账号默认档**：Tier0。国内站累计充值 ¥0 就是 Tier0，可以用认证赠送的 15 元代金券，但不能用于 K3 [13][17]。国际站要先充 $1 才能使用 [22]。在国内站充 ¥10 解锁 K3 后，账号**仍是 Tier0**，要累计 ¥50 才到 Tier1 [7][13]。
- **TPM 的计算口径**：按「请求 token 数 + `max_completion_tokens`」预先计算，不看实际生成量。不传 `max_completion_tokens` 时用默认值计算。原文：「我们会基于你请求的 token 数量加上你 max_completion_tokens 参数的数量来判断你是否达到了速率限制。而不考虑实际生成的 token 数量。」[14]
- **特别说明** [13]：「当集群负载达到容量上限时，我们可能会采取临时的限流措施，对各类限速进行调整」；「当系统检测到账户存在异常行为时，会触发风控限速策略，该限制一旦触发即无法解除」。K3 页曾预告：「我们预备在 8 月对"充值等级与限速"规则进行更新」[7]。
- **超限返回**：HTTP 429，正文格式为 `{"error": {"type": ..., "message": ...}}`。[15][25]

  | error type                     | 含义                                                                                                                                                                                                                                                                                                   |
  | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `rate_limit_reached_error`     | 组织级并发、RPM、TPM 或 TPD 超限。示例原文：`rate_limit_reached_error: Your account {uid}<{ak-id}> request reached TPM rate limit, current:{current_tpm}, limit:{max_tpm}` [16]。国际站的典型 message 如「Organization-level concurrency limit reached」「Organization-level RPM limit reached」[25]。 |
  | `engine_overloaded_error`      | 「The engine is currently overloaded, please try again later」。按 `Retry-After` 等待；「充值或提升 Tier 不能直接消除」[15]。                                                                                                                                                                          |
  | `exceeded_current_quota_error` | 余额不足、欠费或已停用。国际站 message：「Account balance is insufficient or the account has been disabled」「Token quota is insufficient」[15][25]。                                                                                                                                                  |

  「因 429 错误中断的请求不会扣费。」[16]。另外 504 表示「服务端 900 秒无响应」，官方建议改用流式 [15]。

### 订阅套餐（Kimi Code，随 Kimi 会员）

**新套餐**（国内区，人民币）。价格来自 Kimi 会员定价页的数据 [40]；「定价不变」「Go 档无 coding 额度，Plus 及以上档位可使用 Kimi Code」见 [31]；各档可用模型见 [30][36]：

| 档位 | 连续包月 | 连续包年 | Kimi Code      | 可用模型与上下文                                                                    |
| ---- | -------- | -------- | -------------- | ----------------------------------------------------------------------------------- |
| Go   | ¥49      | ¥468     | 无 coding 额度 | —                                                                                   |
| Plus | ¥99      | ¥948     | 可用           | K3（262,144）、K3-256K（262,144）、K2.8 Preview（1,048,576）                        |
| Pro  | ¥199     | ¥1,908   | 可用           | K3（1,048,576）、K3-256K、K2.8 Preview（1,048,576）、K2.7 Code HighSpeed（262,144） |
| Max  | ¥699     | ¥6,708   | 可用           | 同 Pro（「Pro 及以上」）                                                            |

**老套餐**：老会员不受影响，「档位名称、额度规则与自动续费均维持原样」[31]。价格：Andante ¥49/月、Moderato ¥99/月、Allegretto ¥199/月、Allegro ¥699/月；「选择连续包年可享受更大折扣，最高立省 ¥1,680」[38]。Kimi Code 门槛：Andante 及以上（只有 K2.8 Preview）；K3 要 Moderato 及以上；1M 上下文和高速版要 Allegretto 及以上 [30][36]。

**额度与并发** [31][37][38][39]：

- **额度窗口**：新老会员都有「每 5 小时的滚动频率窗口」；周（7 天）额度只有老会员有，新会员「取消每周额度限制」；两类会员都「与 Kimi 会员计划共享月总额度」，月额度用完后「Kimi Code 额度会冻结」。
- **额度数值**：每个窗口允许多少请求或 token，**没查到**。官方说「5小时及周频控请以页面提示为准」[38]。
- **并发**：**没查到**公开数值。风控会限制并发（403「You've reached your concurrent request limit」）；短时请求过多返回 429「We're receiving too many requests at the moment」[33]。
- **Key 共享**：「所有登录设备和 API Key 共享同一套配额」[31]。

**超额行为** [31][33]：

- 触顶时返回 HTTP 403：
  - 「You've reached your 5-hour usage limit…」
  - 「You've reached your weekly (7-day) usage limit…」（仅老会员）
  - 「You've reached your monthly usage limit for this billing cycle…」
- 开启加油包后，「任意额度触顶都会无缝切到加油包余额」。
- 加油包「价格近似于 Kimi 开放平台的官方 API 价格」；「单次最低 25 RMB，每日最多 10 次、累计 3,000 RMB，余额上限 10,000 RMB」；可以设每月消费上限。

**没查到的项**：

- 海外（美元）会员价格。英文帮助页也只列了人民币标价的旧档位 [44]。
- 各档具体额度数值。

备注：

- 帮助中心的「Kimi Code 权益说明」还写着「新会员体系即将上线。届时 Kimi 会员权益将与 Kimi Code 权益拆分」[37]，这与 Kimi Code 文档（新套餐 Go / Plus / Pro / Max）不一致，本文以 Kimi Code 文档为准。
- 定价接口里还能看到几款标记为需申请、不能直接购买的 Kimi Code 独立商品（Starter / Explorer / Expert / Master）。官方文档没有介绍，本文不作为结论。

## 对 DocFlow 的建议

| 项               | 建议                                                                                                                                                                                                                                                                                           | 依据           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 显示名           | 国内站沿用「月之暗面（Kimi）」。如果另加国际站预设，可叫「Kimi（国际站）」。                                                                                                                                                                                                                   | —              |
| Base URL（按量） | 国内 `https://api.moonshot.cn/v1`，规划里的现值正确；国际 `https://api.moonshot.ai/v1`。                                                                                                                                                                                                       | [2][24]        |
| Base URL（套餐） | Kimi Code 国内 `https://api.kimi.com/coding/v1`，海外 `https://api.kimi.ai/coding/v1`。**不建议做成预设**，原因见风险 1。                                                                                                                                                                      | [30][32]       |
| Key 获取页       | 国内 https://platform.kimi.com/console/api-keys。规划里的 `platform.moonshot.cn/console/api-keys` 会 301 到这里，建议直接改成新地址。国际 https://platform.kimi.ai/console/api-keys。                                                                                                          | [1][24]        |
| 新账号安全并发数 | **1**。新账号是 Tier0：并发 1、RPM 3、TPM 500,000、TPD 1,500,000，DocFlow 默认的 100 会立刻引发大量 429。建议在设置里按档位提示用户上调：Tier1 15、Tier2 40、Tier3 50、Tier4 60、Tier5 100。                                                                                                   | [13][22]       |
| 默认翻译温度     | 所有 Kimi 模型都**不发送 temperature**。现役模型全是固定值，传其他值会报错；K2.6 非思考时实际为 0.6。                                                                                                                                                                                          | [4][9]         |
| 是否默认关闭思考 | 首选 `kimi-k2.6` 并关闭思考：`{"thinking": {"type": "disabled"}}`。这个参数**只适用于 K2.6**：`kimi-k2.7-code` 传 `disabled` 会报错；`kimi-k3` 不支持 `thinking` 参数，官方要求迁移时移除。DocFlow 的 `extraBody` 是服务商级的，同一服务商下换模型就会出错，需要改成按模型设置，或在界面提示。 | [4][8][9][10]  |
| max_tokens       | 建议显式设为 **16384**。Kimi 按「输入 token + `max_completion_tokens`」预占 TPM，不传就按默认值算（K2.6 为 32768，K3 为 131072），会过早撞上 TPM 上限。官方也建议思考模式下 `max_tokens>=16000`。这需要 DocFlow 支持按服务商或模型设置 `maxOutputTokens`。                                     | [5][9][10][14] |
| 首选翻译模型     | **`kimi-k2.6`**（非思考）。它是唯一能关闭思考的现役模型，价格也最低（国内输入未命中 ¥6.5、输出 ¥27，国际 $0.95 / $4，均为每百万 token）。K3 始终思考，未命中输入单价约为 K2.6 的 3 倍、输出约 3.7 倍，国内还要先充值才能用。K2.7 Code 面向编程，而且不能关闭思考。                             | [4][7][12][23] |

风险提示：

1. **Kimi Code 套餐条款不允许 DocFlow 这类用法**。原文是「仅限个人交互式使用场景。通过脚本批量执行、数据标注等非交互式方式使用，超出了正常使用范畴」。DocFlow 批量翻译整篇 PDF 属于非交互式批处理，违规可能被限制并发，甚至封号 [32]。建议不提供 Kimi Code 预设；用户在「自定义服务商」里自己填写时给出提示。DocFlow 应一直发送真实的 `User-Agent: DocFlow/<version>`，不要伪装成编程工具，条款禁止伪造客户端身份 [32][37]。
2. **温度固定**。以后如果做「按模型设置温度」，Kimi 必须映射为「不发送」，否则请求报错。[4]
3. **新账号限速极低**。Tier0 下 RPM 3 往往先于并发触顶。DocFlow 的自适应只调并发、不调请求速率，Tier0 即使并发为 1 也可能持续收到 429，只能靠 `Retry-After` 或默认 5 s 退避。另外国内充 ¥10 解锁 K3 后仍是 Tier0。[7][13]
4. **三套 Key 互不通用**：国内站、国际站、Kimi Code，混用会返回 401。[15][25][33]
5. **旧模型 ID 已下线**（`moonshot-v1-*`、`kimi-k2-*`、`kimi-k2.5`、`kimi-latest`），调用返回 404。预设不带默认模型的规定要保持。[3][19]
6. **文档和控制台域名已迁移**：platform.moonshot.cn → platform.kimi.com，platform.moonshot.ai → platform.kimi.ai（301）。API 域名没变。[1][2]
7. **限速规则会变**：官方预告过 8 月调整；集群满载时可能临时收紧；风控限速「一旦触发即无法解除」。[7][13]
8. **非流式超时**：服务端 900 秒无响应时网关返回 504 [15]。DocFlow 用 `stream: false` 和 15 分钟超时，K3（默认 `max` 推理）的长请求有风险，用 K2.6 非思考可以避开。

## 来源

1. [快速开始（Kimi API 开放平台）](https://platform.kimi.com/docs/get-api-key)（2026-09-23 访问）
2. [API 概述](https://platform.kimi.com/docs/api/overview)（2026-09-23 访问）
3. [模型列表](https://platform.kimi.com/docs/models)（2026-09-23 访问）
4. [模型参数参考](https://platform.kimi.com/docs/api/models-overview)（2026-09-23 访问）
5. [Chat Completions API](https://platform.kimi.com/docs/api/chat)（2026-09-23 访问）
6. [Messages API](https://platform.kimi.com/docs/api/messages)（2026-09-23 访问）
7. [Kimi K3](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)（2026-09-23 访问）
8. [Kimi K2.7 Code](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart)（2026-09-23 访问）
9. [Kimi K2.6](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)（2026-09-23 访问）
10. [思考模型](https://platform.kimi.com/docs/guide/use-thinking-models)（2026-09-23 访问）
11. [推理强度](https://platform.kimi.com/docs/guide/use-reasoning-effort)（2026-09-23 访问）
12. [模型推理价格说明](https://platform.kimi.com/docs/pricing/chat)（2026-09-23 访问）
13. [充值与限速](https://platform.kimi.com/docs/pricing/limits)（2026-09-23 访问）
14. [主要概念 · 速率限制](https://platform.kimi.com/docs/introduction)（2026-09-23 访问）
15. [常见错误码说明](https://platform.kimi.com/docs/api/errors)（2026-09-23 访问）
16. [问题排查](https://platform.kimi.com/docs/guide/troubleshooting)（2026-09-23 访问）
17. [账号与财务](https://platform.kimi.com/docs/guide/account-and-payments)（2026-09-23 访问）
18. [与 Kimi 其他产品对比](https://platform.kimi.com/docs/guide/product-plans)（2026-09-23 访问）
19. [平台新功能发布记录](https://platform.kimi.com/docs/changelog)（2026-09-23 访问）
20. [基准测试最佳实践](https://platform.kimi.com/docs/guide/benchmark-best-practice)（2026-09-23 访问）
21. [Kimi 开放平台服务协议（2026-08-31 生效）](https://platform.kimi.com/docs/agreement/modeluse)（2026-09-23 访问）
22. [Recharge and Rate Limiting（国际站）](https://platform.kimi.ai/docs/pricing/limits)（2026-09-23 访问）
23. [Model Inference Pricing Explanation（国际站）](https://platform.kimi.ai/docs/pricing/chat)（2026-09-23 访问）
24. [API Overview（国际站）](https://platform.kimi.ai/docs/api/overview)（2026-09-23 访问）
25. [Common Error Codes（国际站）](https://platform.kimi.ai/docs/api/errors)（2026-09-23 访问）
26. [Kimi K3（国际站）](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)（2026-09-23 访问）
27. [Model Parameter Reference（国际站）](https://platform.kimi.ai/docs/api/models-overview)（2026-09-23 访问；温度约束与 [4] 一致）
28. [Model List（国际站）](https://platform.kimi.ai/docs/models)（2026-09-23 访问；下线清单与 [3] 一致）
29. [Kimi Code 文档 · 产品概览](https://www.kimi.com/code/docs/)（2026-09-23 访问）
30. [Kimi Code 文档 · 模型配置](https://www.kimi.com/code/docs/kimi-code/models.html)（2026-09-23 访问）
31. [Kimi Code 文档 · 会员权益](https://www.kimi.com/code/docs/kimi-code/membership.html)（2026-09-23 访问）
32. [Kimi Code 社区倡议](https://www.kimi.com/code/docs/kimi-code/community-guidelines.html)，英文版 [Community Guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html)（2026-09-23 访问）
33. [Kimi Code 错误参考](https://www.kimi.com/code/docs/kimi-code/error-reference.html)（2026-09-23 访问）
34. [Kimi Code 常见问题](https://www.kimi.com/code/docs/kimi-code/faq.html)（2026-09-23 访问）
35. [Kimi Code 最新动态](https://www.kimi.com/code/docs/kimi-code/whats-new.html)（2026-09-23 访问）
36. [在 OpenCode 中使用（Kimi Code 文档）](https://www.kimi.com/code/docs/third-party-tools/opencode.html)（2026-09-23 访问）
37. [Kimi Code 权益说明（Kimi 帮助中心）](https://www.kimi.com/zh-cn/help/kimi-code/benefits)（2026-09-23 访问）
38. [会员是怎么收费的/套餐包括什么？（Kimi 帮助中心）](https://www.kimi.com/help/membership/membership-pricing)（2026-09-23 访问）
39. [会员额度更新与使用规则（Kimi 帮助中心）](https://www.kimi.com/help/membership/membership-update-rules)（2026-09-23 访问）
40. [Kimi 会员定价页](https://www.kimi.com/membership/pricing)。页面由前端渲染，价格读自同一官方接口 `POST https://www.kimi.com/apiv2/kimi.gateway.order.v1.GoodsService/ListGoods`（2026-09-23 读取，返回国内区 REGION_CN 商品）
41. [Kimi Code 落地页](https://www.kimi.com/code/)（2026-09-23 访问）
42. [在 Claude Code 中使用（Kimi Code 文档）](https://www.kimi.com/code/docs/third-party-tools/claude-code.html)（2026-09-23 访问）
43. [在 Codex 中使用（Kimi Code 文档）](https://www.kimi.com/code/docs/third-party-tools/codex.html)（2026-09-23 访问）
44. [Membership Pricing and Plan Overview（Kimi 英文帮助页）](https://www.kimi.com/en/help/membership/membership-pricing)（2026-09-23 访问）
