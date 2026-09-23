# 2026-09-23 服务商调研补齐（第二轮）

## 会话 1（Kimi Work，18:10 开始）

### 目标

按第一轮（见 [providers.md](2026-09-23-providers.md)）定下的六段结构，把规划 4.2 里剩下的云端预设全部调研完：OpenAI、Anthropic、Google Gemini、OpenRouter、硅基流动、阿里云百炼、火山引擎、智谱 AI、腾讯混元、阶跃星辰、零一万物、xAI、Mistral AI、Azure OpenAI，外加要求补上的 MiniMax。

### 做了什么

- 新写 15 份笔记，全部在 `docs/reference/providers/`：openai、anthropic、gemini、openrouter、siliconflow、dashscope、volcengine、zhipu、hunyuan、stepfun、lingyi、xai、mistral、azure、minimax。
- 更新 [providers/README.md](../reference/providers/README.md) 进度表：19 家全部完成，附「对预设清单的净改动」清单。
- 关键发现：
  - **零一万物已停运**：官方公告 2026-09-03 24:00 停止 API 服务（lingyi.md 有出处），`lingyi` 预设应从 4.2 预设表移除。
  - **温度策略要大改**：2026 年主流模型是推理模型，OpenAI / Azure（除 gpt-6-astra）/ Anthropic 新款 / Gemini 3 对非默认温度报 400 或会 looping；Gemini 3 官方明确建议移除显式 temperature。只有 DeepSeek（1.3+关思考）、MiMo 等少数适合传温度。
  - **MiniMax 结论与 MiMo 相反**：Token Plan 官方定位不限于编码工具（可接任意 OpenAI 兼容工具），可做成第二个套餐预设。
  - 火山引擎 TPM 是**预扣机制**，高并发会放大限流；阿里云百炼思考模式输出加价（qwen-plus 4 倍）；Azure 新订阅常见 TPM=0 部署失败；腾讯混元有官方「翻译专用模型」hunyuan-translation。

### 怎么验证的

- 只改文档，没有跑 `npm run check`。
- 交叉核对规则：优先官方页面（docs / 定价页 / 限流页 / 官方公告），官方抓不到时用官方论坛/官方社区文章，第三方数据一律标注「非官方」或「未查到」。每家文末带来源编号。

### 没做成 / 坑

- ai.google.dev 与 platform.openai.com 部分页面直连抓取失败/内容截断，改用站内搜索 + 官方论坛交叉确认；OpenAI 每模型 RPM/TPM 官方本来就不公布（账号后台动态展示）， Gemini 付费档精确数值同样只给账号实时页。
- OpenAI GPT-5.x 各模型的逐模型价、MiniMax M3 定价、智谱/腾讯云 Coding Plan 价格没抓到，笔记里标「未查到」，改预设前要人工补核。
- Anthropic「Opus 4.7 起弃用 temperature」只有社区/第三方库口径，官方参数页还没更新，笔记里按「默认不发 temperature」的保守策略写。

### 下一步

- 按 README「净改动」清单改 `src/shared/presets.ts`：移除 `lingyi`、新增 `minimax`（+可选 Token Plan 预设）、DeepSeek Base URL 去 `/v1`、给各预设配默认并发与 extraBody（思考开关）。请求代码的「每服务商温度」逻辑要改成「默认不传」。
- 改预设时用各笔记里的首选模型与新账号并发数；标注「未查到」的价格项在 UI 文案里不要引用具体数字。

### 提交

- 见本次 `docs: 补齐其余 15 家服务商调研`。
