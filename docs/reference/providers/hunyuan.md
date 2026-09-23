# 腾讯混元（Hunyuan）

> 查证日期 2026-09-23。数值以官方页面为准，来源见文末编号。

## 概览

- 腾讯混元系列：现行主力 `hunyuan-turbos-latest`（TurboS）、`hunyuan-t1`、第三代 `hy3`（Hy3，2026-04 预览、07 正式，256K 窗口）；`hunyuan-lite` 免费档；专用翻译模型 `hunyuan-translation` / `hunyuan-translation-lite`；多模态 vision 系。[1][2]
- 国内站（cloud.tencent.com，人民币），国际站（tencentcloud.com，美元）两边隔离；OpenAI 兼容接口 `https://api.hunyuan.cloud.tencent.com/v1`。[1][3]
- **订阅套餐：腾讯云 Coding Plan**（Lite ¥40/月、Pro ¥200/月；编码工具向，5 小时/周/月三级滚动限额；支持 tc-code-latest、HY 2.0、GLM-5、Kimi-K2.5、MiniMax-M2.5 等）——编码场景套餐，不建议做成翻译预设。[4]
- 产品侧在往 **TokenHub**（多模型调度网关）迁移，旧控制台路径仍可用但新开通路径可能不同。[2][3]

## 接入方式

### 按量 API（console.cloud.tencent.com/hunyuan）

| 项目       | 内容                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 计费方式   | 资源包（新开通送免费额度，如标准版累计 10 万 token、12 个月有效）+ 后付费（需在控制台手动开通，默认不开，否则会「计费异常提示」）。[1][5] |
| Base URL   | `https://api.hunyuan.cloud.tencent.com/v1`（OpenAI 兼容；规划 4.2 一致）。另有原生 SDK（SecretId/SecretKey）路径。[3]                     |
| 鉴权方式   | `Authorization: Bearer ${HUNYUAN_API_KEY}`（sk 开头）；根账号直调可能触发限流，官方建议建 RAM 子账号。[3]                                 |
| Key 获取页 | https://console.cloud.tencent.com/hunyuan/api-key（规划 4.2 一致）。国际站 Key 需单独开 Hy3 模型权限。[3]                                 |

价格（元/百万 tokens，官方计费概述）[1]：

| 模型                                  | 输入           | 输出 | 备注                                          |
| ------------------------------------- | -------------- | ---- | --------------------------------------------- |
| `hunyuan-translation`                 | 1.2            | 3.6  | **专用翻译模型**，有独立 ChatTranslations API |
| `hunyuan-translation-lite`            | 1.0            | 3.0  | 翻译轻量版                                    |
| `hunyuan-a13b`                        | 0.5            | 2.0  | 轻量主力                                      |
| `hunyuan-role-latest`                 | 2.4            | 9.6  | 角色扮演                                      |
| `hunyuan-turbos-vision` / `t1-vision` | 3.0            | 9.0  | 多模态                                        |
| `hunyuan-lite`                        | 免费           | 免费 | 社区口径 256K 上下文，限速较严                |
| TurboS / T1 档                        | 未在抓取中获得 | —    | 官方标注**即将下线**，以控制台为准            |

### 订阅套餐（Coding Plan）

Lite ¥40/月（5 小时窗口约 1,200 次、周约 9,000、月约 18,000）、Pro ¥200/月（5 倍量）；编码工具向，**不建议做成 DocFlow 翻译预设**。[4]

## 模型

- 思考模型：`hy3`（256K 窗口）与 t1/turbos 系；`hunyuan-lite`/a13b 为非思考轻量档。思考开关具体参数未查到统一文档 → 以模型页为准。
- 温度/采样：未查到按场景推荐表。
- **`hunyuan-translation` 是少见的官方「翻译专用」模型**，对 DocFlow 是差异化选项（但走 Chat 接口还是专用 ChatTranslations 接口需验证；DocFlow 走 chat/completions，先按普通模型试）。

## 限流与档位

### 按量 API

- 公开文档**未给出统一 RPM/TPM 表**；429 为速率限制（RPM/TPM 超限或额度耗尽），官方建议指数退避 + 账单告警。[3]
- 社区实测口径（非官方）：`hunyuan-lite` 约 40 RPM + IP 级限流（同 IP 1 分钟超 100 次返 429）；标准版免费档 QPS=5。[3][6]
- 后付费不开通时免费额度耗尽会「计费异常」，不是 429 而是开通提示。[1]

### 订阅套餐

Coding Plan 见前文。

## 对 DocFlow 的建议

| 项               | 建议                                                                                                                           | 依据          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 显示名           | 腾讯混元                                                                                                                       | 规划 4.2 已定 |
| Base URL         | `https://api.hunyuan.cloud.tencent.com/v1`（规划一致）                                                                         | [3]           |
| Key 获取页       | https://console.cloud.tencent.com/hunyuan/api-key                                                                              | —             |
| 新账号安全并发数 | **5**。免费/lite 档限速严（QPS 5 量级）；付费档未公开限速，5 起步靠自适应升。                                                  | [3][6]        |
| 翻译请求构造     | 不传温度（官方无推荐表）；思考开关未查实前保持默认。                                                                           | —             |
| 首选翻译模型     | **`hunyuan-translation`**（专用翻译模型，¥1.2/¥3.6，性价比与定位都贴合）；通用备选 `hunyuan-a13b`；免费体验用 `hunyuan-lite`。 | [1]           |
| 注意             | `hunyuan-t1` / `hunyuan-turbos-latest` 官方标注即将下线，不要写死。                                                            | [4]           |

风险提示：

1. **产品迁移期**：混元能力向 TokenHub 迁移，控制台路径、模型开通流程短期可能变化；DocFlow 预设只依赖 Base URL + Key，不受影响，但用户指引要写得保守。[2][3]
2. **后付费默认关闭**：免费额度耗尽后不开后付费会报错，用户可能误以为是 Key 坏了；错误提示文案建议覆盖。[1]
3. **lite 免费档限速严 + IP 级限流**：批量翻译场景（如校园网同 IP 多用户）容易互相挤兑。[6]
4. **Root 账号限流**：官方建议 RAM 子账号，个人用户一般无感，企业用户需注意。[3]

## 来源

1. [混元生文计费概述 - 腾讯云（官方）](https://cloud.tencent.com/document/product/1729/97731)（2026-09-23 访问）
2. [混元 API 模型指南（影图AI，含官方来源边界核查）](https://yingtu.ai/zh/blog/hunyuan-api-model-guide)（2026-09-23 访问）
3. [腾讯云国际站混元使用教程（实操口径：Base URL、RAM 子账号、429）](https://www.wanyuna.com/post/1046.html)（2026-09-23 访问）
4. [腾讯云 Coding Plan 详解（非官方汇总）](https://coding-plan.org/plans/tencentcloud)（2026-09-23 访问）
5. [国内外商用大模型并发测试（免费额度口径）](https://zhuanlan.zhihu.com/p/687532112)（2026-09-23 访问）
6. [2026 年 8 月 AI 免费额度一张表（hunyuan-lite 限速口径）](https://mrkjai.com/discover/571727dc-9e23a674)（2026-09-23 访问）
