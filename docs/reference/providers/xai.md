# xAI（Grok）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- xAI（马斯克系）Grok 系列。API 在售的主要便宜款：`grok-4-fast-reasoning` / `grok-4-fast-non-reasoning`（2M 上下文，2025-09 发布）、`grok-code-fast-1`（编码向）；旗舰 `grok-4` 及更新款见定价页。[1][2]
- 只有国际站（api.x.ai / console.x.ai），需海外支付；服务条款保留「我们可自行实施速率限制」的权利。[3]
- 无 API 订阅套餐（SuperGrok / X Premium+ 是聊天与 X 产品权益，未查到含 API 额度）。[3]

## 接入方式

### 按量 API（api.x.ai）

| 项目 | 内容 |
| --- | --- |
| 计费方式 | 按 token 美元计价；缓存命中低价；grok-4-fast 按输入长度分两档（<128K / ≥128K）。[1] |
| Base URL | `https://api.x.ai/v1`（OpenAI 兼容，规划 4.2 一致）。 |
| 鉴权方式 | `Authorization: Bearer ${XAI_API_KEY}`。 |
| Key 获取页 | https://console.x.ai（规划 4.2 一致）。 |

价格（每百万 tokens）[1][2]：

| 模型 | 输入（<128K / ≥128K） | 输出 | 缓存输入 | 上下文 |
| --- | --- | --- | --- | --- |
| `grok-4-fast-reasoning` | $0.20 / $0.40 | $0.50 / $1.00 | $0.05 | 2M |
| `grok-4-fast-non-reasoning` | $0.20 / $0.40 | $0.50 / $1.00 | $0.05 | 2M |
| `grok-code-fast-1` | $0.20 | $1.50 | $0.02 | — |

### 订阅套餐

无（见概览）。

## 模型

- `grok-4-fast` 拆成 reasoning / non-reasoning 两个独立模型 ID，**non-reasoning 版天然适合翻译**（无思考开销，官方称比 grok-4 少用 40% thinking tokens 的思路就是把它独立出来）。[1]
- 温度 / 采样：官方未抓到按场景推荐表；OpenAI 兼容参数透传。

## 限流与档位

### 按量 API

- **公开文档未给 RPM/TPM 表**；条款只说可自行限速；新账号（曾送 $25 额度，2024-12 口径）实际限额以 console 为准 → **未查到**。[3][4]
- 429 语义未查到专文。

### 订阅套餐

无。

## 对 DocFlow 的建议

| 项 | 建议 | 依据 |
| --- | --- | --- |
| 显示名 | xAI（Grok） | 规划 4.2 已定 |
| Base URL | `https://api.x.ai/v1`（规划一致） | — |
| Key 获取页 | https://console.x.ai | — |
| 新账号安全并发数 | **10**（限额未公开，保守起步）。 | [3] |
| 翻译请求构造 | 选 non-reasoning 模型就无需思考开关；不传温度（无官方推荐值）。 | [1] |
| 首选翻译模型 | **`grok-4-fast-non-reasoning`**（$0.2/$0.5，2M 上下文，便宜大碗）。 | [1] |

风险提示：

1. **限价分档陷阱**：输入 ≥128K 价格翻倍，DocFlow 长段落塞满上下文时成本翻倍；分段翻译能躲开这档。[1]
2. **限速不透明**：全靠自适应降并发兜底。[3]
3. **模型 ID 分裂**：reasoning/non-reasoning 是两个 ID，用户拿错就会为思考 token 付费；获取模型列表后注意后缀。[1]
4. **区域与支付**：需海外支付方式。[3]

## 来源

1. [Grok 4 Fast | xAI（官方博客，含定价）](https://x.ai/blog/grok-4-fast)（2026-09-23 访问）
2. [Grok Code Fast 1 | xAI（官方博客，含定价）](https://x.ai/blog/grok-code-fast-1)（2026-09-23 访问）
3. [xAI Terms of Service（速率限制条款）](https://x.ai/legal/terms-of-service/previous-2025-11-04)（2026-09-23 访问）
4. [Bringing Grok to Everyone | xAI（$25 免费额度历史口径）](https://x.ai/blog/grok-1212)（2026-09-23 访问）
