# 0002：OpenAI-compatible 结构化生成边界

- 状态：Accepted
- 日期：2026-08-11
- 范围：M0 — First Ripple

## 问题与边界

M0 只需要一个服务端文本生成接口：向用户明确配置且信任的 OpenAI-compatible Chat Completions 端点发送任务必要上下文，接收一个 JSON 候选，再由本地 Schema 和领域 Validator 决定是否写入 Artifact。它不需要多模型路由、流式 UI、工具调用、Agent、RAG 或供应商自动探测。

必要内部接口只有 `AIProvider.generate(request)`。调用方只依赖模型名、显式结构化输出模式、JSON Schema、版本化 Prompt 和一次完整 repair；供应商 SDK 类型不得泄漏到领域层。

## Open-source preflight

检索日期：2026-08-11。只核对官方仓库、官方文档、npm 元数据和当前锁文件。

| 候选 | 许可证与维护/采用信号 | 体积与 API 适配 | 决定 |
| --- | --- | --- | --- |
| [OpenAI Node SDK](https://github.com/openai/openai-node) 7.4.0 | Apache-2.0；官方仓库约 11k Stars，持续发布，公开 Issue 可追踪；Node 22 在官方支持范围 | 当前安装目录约 19 MB、无额外 runtime dependency；原生支持 Chat Completions、`baseURL`、请求选项和错误类型 | **采用并锁定**。现有代码只在一个适配文件导入 SDK，删除了更多自有 HTTP 代码 |
| [Node.js 22 原生 `fetch`](https://nodejs.org/docs/latest-v22.x/api/globals.html#fetch) | Node 运行时内置，稳定 API，无新增包 | 依赖体积最低，但需自建认证头、URL 拼接、非 2xx 错误、响应类型、usage / request ID 映射和兼容端点差异处理 | 不采用。M0 的自有代码与测试面会增加，净复杂度更高 |
| [Vercel AI SDK](https://github.com/vercel/ai) 7.0.59 + `@ai-sdk/openai` 4.0.37 | Apache-2.0；官方仓库约 26.1k Stars、活跃发布，公开 Issue 数较多 | npm 解包体积合计约 9.5 MB；统一 Provider、生成与 UI 能力强，但会叠加 NovelRipple 已有 `AIProvider` 和 Zod 管线 | 不采用。M0 不需要 Gateway、多供应商、流式 UI 或 Agent 抽象 |

许可证均与当前仓库使用方式兼容；本次不复制候选代码，也不新增依赖。`openai` 继续由 `package-lock.json` 精确锁定。移除成本只涉及替换 `src/server/ai/openai-compatible-provider.ts` 内部实现并保持 `AIProvider` 合同。

## 决定

保留官方 `openai` SDK，但把它限制在 `OpenAICompatibleProvider` 内。端点、模型和 Structured Output 模式必须由服务端配置显式给出；不探测能力、不切换供应商、不在失败后改用另一模式。采用 Chat Completions 是为了现有 OpenAI-compatible 端点的共同协议，而不是承诺使用 OpenAI 专有的完整产品面。

每次上游请求：

- 只在服务端读取 API key，浏览器永远拿不到密钥；
- 使用固定 120 秒请求超时并将 SDK 自动重试设为 `0`，避免 SDK 重试与本地一次 repair 叠加；
- `json_schema` 模式发送 strict JSON Schema；`prompt_json` 模式只依赖同一 Schema 提示，但不会伪装为端点原生约束；
- 响应先解析为 JSON，再通过本地 Zod Schema、Evidence、引用和领域不变量校验；一次完整 repair 仍失败即 fail closed；
- 不把 Source 正文、完整 Prompt、API key 或 raw model output 写入 Live Eval / 人工复核报告。

官方 SDK 公开 Issue 仍是升级评估输入，尤其是超时、兼容端点和响应体处理。升级前必须运行 Provider 单测、合约测试和真实端点 Live Eval，不能只依赖 SemVer。

## 隐私与数据最小化

Story Map 提取需要处理用户选择的 Source，因此正文会发送到 `OPENAI_BASE_URL` 指向的端点；用户必须只配置满足其数据处理要求的服务。Ripple 只发送 confirmed Story Map 与当前分歧上下文，Continuation 只发送相关 Canon Evidence、accepted Impact Plan 和当前 Delta，不再次拼接整部 Source。

Generation Run 的诊断状态保留在本地数据库；对外或人工报告只允许脱敏指标、稳定 ID 和简短判断。SDK 只能访问调用参数与服务端配置，不拥有 Story Map、Worldline 或 Artifact 写入权限。

## 替换边界

如果未来需要更换 SDK 或改用原生 `fetch`，新实现必须继续满足 `AIProvider.generate`：接收版本化 Prompt、JSON Schema 和显式模型配置，返回文本候选、可选 request ID 与 usage。结构校验、一次 repair、Generation Run、Artifact 提交和领域不变量仍由现有本地管线拥有，不随供应商迁移。

只有真实 M0 兼容性、维护或安全证据证明当前 SDK 成为负担时才替换；不得借替换引入多模型路由、Gateway、Agent 或第二套结构化输出管线。
