# 2026-09-23 服务商调研入库

## 会话 1（Cursor / Grok 4.7，17:34）

### 目标

把已经写好、尚未入库的服务商调研提交并推送，并在索引里标出完成进度。

### 做了什么

- 核对 `docs/reference/providers/`：DeepSeek、Groq、月之暗面、小米 MiMo 四份已按六段结构写完（查证日 2026-09-23）。规划 4.2 的 17 家云端预设里完成 3 家，MiMo 是额外的，MiniMax 还没写。
- 在 `docs/reference/providers/README.md` 补了进度表。`docs/README.md` 的参考资料条目指向这份索引。
- 预设与请求代码没有改。

### 怎么验证的

- 只改文档，没有跑 `npm run check`。

### 没做成 / 坑

- 四份笔记里标「未查到」的是官方没公开的数字（例如 DeepSeek 的 RPM/TPM、Kimi Code 的额度与并发、MiMo 的并发和海外 Base URL），不是没写完。

### 下一步

- 继续按同一结构写剩下的云端预设：OpenAI、Anthropic、Gemini、OpenRouter、硅基流动、阿里云百炼、火山引擎、智谱、腾讯混元、阶跃星辰、零一万物、xAI、Mistral、Azure，以及 MiniMax。
- 全部写完后再改 `src/shared/presets.ts` 和请求代码。Ollama、LM Studio、自定义服务商不单独调研。

### 提交

- 见本次 `docs: 记录已完成的服务商调研`。
