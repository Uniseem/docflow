# Mistral AI（La Plateforme）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 法国厂商，欧盟数据合规是卖点。现行模型：`mistral-small-4`（128K，Apache 2.0 同权重）、`mistral-medium-3` / `medium-3.5`、`mistral-large-3`（旗舰）、`mistral-nemo`（最低价）、Codestral/Devstral（编码）、Pixtral（视觉）、Voxtral（语音）。[1][2]
- 只有国际站（console.mistral.ai / api.mistral.ai），支持欧元/美元。
- **无 API 订阅套餐**：Le Chat Pro（$14.99/月）纯聊天产品，不含 API 额度；API 只有「Experiment（免费评估档）+ 按量付费」两档。[3]

## 接入方式

### 按量 API（La Plateforme）

| 项目       | 内容                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式   | 按 token 计价；免费档叫 Experiment；开通按量付费（pay-as-you-go）即 Tier 1，之后按累计**实际账单**升档（充值不算，要花掉）：Tier 2 >$20/€20、Tier 3 >$100/€100、Tier 4 >$500/€500，更高联系支持。[1] |
| Base URL   | `https://api.mistral.ai/v1`（OpenAI 兼容，规划 4.2 一致）。                                                                                                                                          |
| 鉴权方式   | `Authorization: Bearer ${MISTRAL_API_KEY}`。                                                                                                                                                         |
| Key 获取页 | https://console.mistral.ai/api-keys（规划 4.2 一致）；注册需手机号验证，免费档不需要信用卡。[4]                                                                                                      |

价格（美元/百万 tokens，非官方汇总口径，改预设前以官方定价页核对）[2][5]：

| 模型               | 输入       | 输出      | 上下文    |
| ------------------ | ---------- | --------- | --------- |
| `mistral-small-4`  | $0.15~0.20 | $0.60     | 128K      |
| `mistral-medium-3` | $0.40~1.0  | $2.00     | 131K~256K |
| `mistral-large-3`  | $0.50~2.0  | $2.00~6.0 | 131K~256K |
| `mistral-nemo`     | $0.02      | $0.06     | 128K      |

（各家汇总数字互相矛盾，官方页是唯一权威；此处只给量级。）

### 订阅套餐

无（Le Chat Pro 不含 API，见概览）。[3]

## 模型

- 非思考模型为主（Magistral 系为推理款）；温度官方默认 0.7（API 文档历史口径），无按场景推荐表抓到。
- 免费 Experiment 档可用全部模型（含 Large），适合用户零成本试翻译效果。

## 限流与档位

### 按量 API

- **三轴限流**：组织级，按 RPS、TPM、**每月 token 总量**三条独立轴，超任一轴即 HTTP 429。[1]
- **免费档数值官方不公开**（2026-08-12 官方帮助文章口径：限值见 Admin Panel → API → Limits）；第三方跟踪器口径约 1 RPS、每月约 10 亿 tokens——**非官方，仅供参考**。[1][4]
- 升档只看累计实付账单（见接入方式）。[1]

### 订阅套餐

无。

## 对 DocFlow 的建议

| 项               | 建议                                                                             | 依据          |
| ---------------- | -------------------------------------------------------------------------------- | ------------- |
| 显示名           | Mistral AI                                                                       | 规划 4.2 已定 |
| Base URL         | `https://api.mistral.ai/v1`（规划一致）                                          | —             |
| Key 获取页       | https://console.mistral.ai/api-keys                                              | —             |
| 新账号安全并发数 | **3**（免费档约 1 RPS 量级；付费 Tier 1 也不高）；开通按量付费后可调到 10。      | [1][4]        |
| 翻译请求构造     | 非思考模型，无需思考开关；温度默认 0.7 可用，建议不传。                          | [2]           |
| 首选翻译模型     | **`mistral-small-4`**（便宜、128K）；免费体验直接 Experiment 档调 Large 试效果。 | [2][5]        |
| 卖点提示         | 欧盟厂商，数据合规敏感用户的国际选项。                                           | [3]           |

风险提示：

1. **月 token 总量轴是隐藏天花板**：与 RPM/TPM 独立计，批量翻译可能在速率正常时突然 429。[1]
2. **免费档限速极严**：1 RPS 量级只够单文档慢慢翻，并发一高全灭。[4]
3. **价格表混乱**：第三方汇总互相矛盾（Medium 3 输入 $0.4 vs $1.0），改预设前必须核官方定价页。[2][5]
4. **升档看实付不是充值**：用户预存大钱不会立刻提速，要真实消耗到档位。[1]

## 来源

1. [Mistral API rate limits 帮助文章（经 provod.AI 与 BenchLM 转述核对）](https://benchlm.ai/free-tier/mistral)（2026-09-23 访问）
2. [Mistral API Pricing 2026（SHIM 汇总）](https://getshim.tech/blogs/mistral-api-pricing)（2026-09-23 访问）
3. [Mistral AI Pricing in 2026（Le Chat Pro 与 API 分离口径）](https://www.grizzlypeaksoftware.com/articles/p/mistral-ai-pricing-in-2026-pro-costs-free-tier-limits-and-api-rates-lx4o2n2v)（2026-09-23 访问）
4. [freellm.net Mistral 页（免费档口径，非官方）](https://freellm.net/providers/mistral-ai)（2026-09-23 访问）
5. [AIToolTier Mistral 定价汇总](https://aitooltier.com/pricing/mistral)（2026-09-23 访问）
