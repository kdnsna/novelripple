# 0001：Web-first 单体基础架构

- 状态：Accepted
- 日期：2026-08-11
- 范围：M0 — First Ripple

## 问题与边界

M0 必须让普通读者在同一界面中对照原文、故事事件、因果边、影响预览和世界线。首版是本地单用户产品，不需要多人协作、独立 API 服务、超大图分析、云数据库或多模型编排。

必要接口只有：

- 服务端读取 Source / Artifact / Worldline；
- 用户确认触发受 Schema 保护的写入；
- 浏览器渲染约 10—20 个可选择的故事事件；
- SQLite 持久化正式状态；
- 固定夹具与 Mock 输出用于自动验证。

## Open-source preflight

检索日期：2026-08-11。数据为当日 GitHub 与 npm 快照；Stars 和 Issue 数只作为维护/采用信号，不作为质量保证。

### Web 框架

采用 Next.js 16.3.0（MIT）。官方 App Router 同一应用即可承载 Server Components、Server Functions 和界面，避免前后端分仓。仓库约 141k Stars、当日仍有提交。M0 默认 Node.js runtime，不使用 Edge runtime，以支持本地 SQLite 文件和原生驱动。

### 故事图候选

| 候选 | 许可证 | 维护/采用快照 | 适配判断 |
| --- | --- | --- | --- |
| React Flow 12.11.2 | MIT | 约 37.9k Stars；当日有提交；npm 解包约 1.2 MB | **采用**。原生提供 React 节点、边、选择、缩放和平移；自定义事件卡片最直接 |
| Cytoscape.js 3.34.0 | MIT | 约 11.2k Stars；当日有提交；npm 解包约 5.7 MB | 不采用。图分析与布局能力更强，但 M0 只需小型可交互故事图，额外 API 面无收益 |
| Sigma.js 3.0.3 + Graphology | MIT | 约 12.1k Stars；当日有提交；合计解包约 3.7 MB | 不采用。优势是 WebGL 大规模网络；M0 只有十余节点，且需 React 内嵌卡片而非海量渲染 |

React Flow 只在浏览器中接收已经验证的图数据，不接触原文密钥，也不发起外部数据请求。节点拖动只改变视图，不改变剧情语义。

### 存储候选

采用 SQLite + Drizzle ORM 0.45.2（Apache-2.0）+ `better-sqlite3` 13.0.3（MIT）。Drizzle 官方支持 `better-sqlite3`，Schema 和迁移保留在 TypeScript / SQL 中。驱动近期仍发布预编译版本，Node.js 要求 `>=22`。数据库默认位于未跟踪的 `.data/`，不把用户正文传到外部服务。

未采用 `drizzle-kit`：2026-08-11 的最新稳定版仍通过弃用的 `@esbuild-kit` 链引入已知开发服务器漏洞。M0 只有一次小型初始化迁移，显式提交 SQL 的维护成本更低，也避免将不参与运行时的数据建模工具留在依赖树中。数据模型变复杂后可重新评估。

暂不采用 libSQL/Turso：远程连接、加密扩展和更多 ALTER 能力不是 M0 需求；增加账户、网络和密钥反而扩大隐私面。暂不采用专用图数据库：关系查询规模尚未证明需要。

### 验证工具

采用 Vitest 4.1.10（MIT）和 Playwright 1.62.1（Apache-2.0）。前者验证纯领域函数，后者验证完整浏览器路径。两者均为活跃项目；默认只装 Chromium，避免无证据地扩大 CI 矩阵。

### 暂缓的依赖

不在 Foundation 阶段安装 AI SDK 或任何模型客户端。当前没有最终供应商和线上调用验收，固定夹具足以验证 Schema、证据、分歧与提交语义。真实模型接入时重新预检 SDK 与直接供应商 API，并明确最小外发文本、超时和日志脱敏。

## 决定

采用一个 Next.js App Router 应用、一个本地 SQLite 数据库、React Flow、Zod、Vitest 和 Playwright。包版本由 `package-lock.json` 锁定；不建立 monorepo、独立后端或通用适配层。

## 回滚与替换边界

- React Flow 只拥有视图层节点/边转换，可由另一个渲染器替换而不改变 Story Map Schema；
- Drizzle Schema 和 SQL migration 是数据库事实源，驱动可在 SQLite 契约内替换；
- 模型边界尚未落地，因此没有兼容层需要维护。

## 部署边界（M1 后文补充）

当前产品保持本地单用户形态：所有 Server Action 以客户端传入的 `projectId` 直接读写本地 SQLite，没有会话、登录或所有权校验。这是有意为之的设计边界，不是遗漏——数据落在使用者自己的机器上，威胁模型是"防止误操作与 AI 输出污染"，而不是"防止其他用户访问"。

若未来部署为多用户或公网服务，以下约束会在那一刻成为安全漏洞，必须先行处理：

- 每个 Action / repository 调用都必须绑定会话身份并校验资源所有权；
- `projectId`、`artifactId`、`worldlineId` 不得继续信任客户端传入值；
- 模型端点凭据与用户正文的访问边界需要重新评审。

在此之前，不引入为假想多用户预留的鉴权抽象（见 AGENTS.md 复杂度预算）。
