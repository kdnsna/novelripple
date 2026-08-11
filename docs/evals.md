# 质量与评测

M0 将确定性正确性和模型质量分开验证。确定性门槛必须在每次变更中通过；真实模型评测暂不进入默认 CI。

## 硬不变量

以下规则全部是放行条件。任一失败都必须拒绝当前候选、阻止状态推进并返回可诊断错误：

1. **Source 不可覆盖**：已有 Source 的原文、规范化文本和内容 Hash 不得被导入、重试、分歧或续写操作修改；正文变化必须创建新 Source。
2. **Evidence 必须定位到有效原文**：引用的 Source 与 section 必须存在，偏移必须为原文边界内的非空范围，切片 Hash 必须与 `excerptHash` 一致。
3. **Event ID 唯一**：同一 Story Map 版本内不得出现重复 Event ID。
4. **Edge 不可悬空**：每条 Edge 的起点和终点 Event 必须存在于同一 Story Map 版本，类型只能是 `causes`、`enables` 或 `foreshadows`。
5. **participant 必须存在**：Event 的每个 participant 都必须引用同一 Story Map 版本中存在的 Character。
6. **Worldline 不修改 Canon**：创建或继续任何 Worldline 后，Source、Canon、父世界线和兄弟世界线必须保持不变。
7. **未确认 Impact Plan 不可改变 Worldline**：Preview 可保存候选 Artifact 和 Generation Run，但未接受、失效或校验失败的 Impact Plan 不得创建 Canonical / 子 Worldline、写入 Delta 或触发 Continuation。
8. **严格模式不可静默破坏 Anchor**：每个结局 Anchor 都必须有明确状态；无法兼容时必须返回 `incompatible` 并阻止严格模式世界线创建。
9. **Story Map 必须绑定明确版本**：Story Map 必须绑定 Source 和自身版本；确认、Divergence 与 Impact Plan 都必须引用具体版本，不得自动漂移到其他版本。
10. **非法 AI 输出必须 fail closed**：所有模型结构化输出必须先通过 Schema，再通过 Evidence、引用完整性和领域不变量校验。缺字段、未知枚举、无效引用或语义不变量失败时拒绝整个候选，不得猜测、补字段、部分采用或静默 fallback。
11. **Continuation 不得恢复或倒改世界线事实**：方向必须引用已存在人物；场景新增事实只能进入 `generated:` 命名空间，不得恢复已删除事实，也不得删除 accepted Delta、分歧前 Canon 或严格模式 Anchor 目标。一次定向 repair 仍失败时，Generation Run 标记失败且不得写入场景 Artifact。

## 四层验证

### 1. 领域单元测试

使用 Vitest 覆盖：

- Zod Schema 拒绝非法结构；
- Evidence Offset 与 Hash；
- Story Map 唯一 ID、参与人物和边引用；
- Anchor 状态与 fail-closed；
- Worldline 创建前必须接受 Impact Plan；
- 幂等键与父/兄弟世界线隔离。
- Worldline Delta 确定性派生与 Canon 不变；
- Continuation 方向人物引用与 state patch 冲突检测。

### 2. 合约测试

使用固定模型响应样本验证：

- 合法响应可以形成候选 Artifact；
- 非法 JSON、缺证据和悬空引用被拒绝；
- 如需重试，只能重新请求一个新的完整响应并从头校验；不得修补或部分采用非法响应，失败后不留下半提交状态；
- Prompt / Schema 版本变化必须显式迁移。

独立运行命令为 `npm run test:contract`；`npm test` 仍会执行完整 Vitest 集合。

### 3. 浏览器 E2E

使用 Playwright 和公开夹具覆盖：

```text
创建项目 → 导入基准故事 → 生成并确认 Story Map → 查看 Evidence
→ 生成涟漪预览 → 接受 → 创建 Worldline → 生成三个方向
→ 选择一个方向 → 生成一个场景 → 刷新恢复
```

默认只运行 Chromium；增加浏览器矩阵前先证明存在兼容性需求。

### 4. Live Eval 与人工复核

`npm run eval:live` 使用真实 OpenAI-compatible 配置和 `ripple-001`，不属于 `npm test`、`npm run check` 或默认 CI。它在临时 SQLite 数据库中实际运行 Story Map、三个 Ripple 案例和一条 Continuation，向终端打印摘要，并将不含 Source 正文、Prompt、密钥或原始模型响应的 JSON 报告写入 `.data/evals/m0-live-eval.json`。供应商、模型与 Structured Output 模式来自 `.env.local` / `.env` 中的现有服务端配置；Mock 配置会被明确拒绝。

自动评分只判断可以确定重现的合同：

- 关键事件通过 Golden 与候选 Evidence 区间的一对一重叠映射计算，避免依赖模型措辞或内部 ID；
- 人物通过姓名和别名归并计算；
- Evidence 逐条检查 Source、section、Offset 与 Hash；
- 一级影响按映射后的受影响事件和变化类型计算；
- Anchor 按映射后的结局目标比较，严格不兼容案例必须得到 `incompatible`；
- Continuation 对照 accepted Worldline Delta 检查结构化 `statePatch`。

Golden 没有穷举全文所有合理事件。因此，有合法 Source Evidence 但未匹配 Golden 的事件只进入 `source-backed unmatched` 人工复核清单，不自动判为 hallucination；叙事语义幻觉、主要因果边认可率和场景正文语义仍由人工按 `fixtures/ripple-001/rubric.md` 复核。确定性非法引用、无有效 Evidence 事件与恢复已删除事实则直接使 Live Eval 失败。

真实模型质量不进入默认 CI。存在待验收模型输出时，报告记录供应商、模型、全部 Prompt 版本、事件与人物召回、Evidence 有效率、一级影响命中、Anchor 结果、非法/待复核事件和 Continuation 矛盾；人工补充因果认可率与相对上次退化项。

## `ripple-001` 最低质量门槛

- 核心人物识别率：100%；
- 人工标记关键事件召回率：至少 80%；
- 关键事件证据有效率：100%；
- 主要因果边人工认可率：至少 70%；
- 预设分歧的一级影响召回率：100%；
- 明确不兼容 Anchor 案例必须 100% 返回 `incompatible` 并被拦截；
- Continuation 恢复已被世界线删除或否定事实的次数必须为 0。

这些是 M0 工程基线，不是长期产品 KPI。

## 分享前检查

1. `npm run lint`；
2. `npm run typecheck`；
3. `npm run test:unit`；
4. `npm run test:contract`；
5. `npm test`；
6. `npm run build`；
7. `npm run test:e2e`；
8. 配置真实模型时运行 `npm run eval:live`；
9. 人工检查首页、故事地图、证据抽屉、Ripple Preview 和刷新恢复；
10. 确认截图、日志、数据库和夹具不含真实用户作品或密钥。
