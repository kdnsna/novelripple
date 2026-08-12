# M1-04 Guided Story Map Review

日期：2026-08-13  
状态：用户已授权按推荐方案连续实现  
基线 commit：`2522dd8844f65edb7b0d5886520da0093aba4252`

## 用户结果与最小验收场景

用户打开 AI 生成的 draft Story Map 后，默认看到一份按可解释风险排序的核对队列，而不是必须读完整张图。用户能够直接核对人物、事件、Evidence、Edge 与 Ending Candidate，用少量操作创建不可变 revision；只有全部 readiness 条件成立时，唯一主操作“确认 Story Map 并进入 Ripple”才可用。

最小验收场景：

1. 系统从当前 Story Map、Source、review metadata 与领域 validator 纯派生 Review Queue 和 Readiness Checklist；
2. 用户先核对 inference / 低置信度 / 人物 identity / Ending / 高杠杆分叉 / 重要 Evidence；
3. 人物 merge、Event 新增/删除/重排和 Edge 新增/修改/删除均创建新 revision，旧 Artifact 保持不变；
4. 人物或结构变化更新全部引用，并使受影响确认失效；
5. 新 Event 必须先选择由不可变 Source 自然段确定性派生的 Evidence Unit，再填写事件；
6. stale revision、非法引用、悬空 Edge 或未完成 readiness 均 fail closed；
7. 刷新后恢复最新 revision、核对状态与下一项；confirmed revision 才开放 Ripple。

## 范围与非目标

本 Issue 只实现 Guided Review、最小人物/Event/Edge 修正、Readiness、不可变 revision 与轻量操作记录。完整图保留为次级视图。

不修改 Source、Story Map 最终 Evidence 格式、Prompt、生成管线、Provider、Ripple、Worldline 或 Continuation；不引入通用图编辑器、分析平台、第二套 Artifact/Eval、后台任务、多 Agent、RAG、向量/图数据库、模型路由或新 runtime dependency。

Character split 暂不实现。正式 M1-02 报告证明当前 UI 缺少 split 能力，但没有一篇冻结 benchmark 确认了真实 split correction；本 Issue 的“仅在真实 benchmark 有需求时”条件未成立。Review Queue 会暴露确定性 identity collision，若后续人工记录确认 split 需求，再以真实数据单独定义最小操作。

## Open-source preflight

问题边界是可恢复的小表单、确定性排序和已有图的次级展示，不是拖拽编辑器或表单平台。只核对官方仓库、官方文档与许可；未复制候选代码。

| 候选 | 官方依据与许可证 | 维护、体积与适配判断 | 决策 |
| --- | --- | --- | --- |
| NovelRipple 现有 React / Server Actions / Zod / immutable Artifact | 当前仓库；Next.js 16 本地官方文档 `server-actions.md`、`forms.md` | 已拥有输入校验、stale check、事务、revision、刷新恢复；补充纯函数和小表单即可 | **采用并扩展** |
| React Flow / xyflow | [官方仓库](https://github.com/xyflow/xyflow)、[官方无障碍文档](https://reactflow.dev/learn/advanced-use/accessibility)，MIT；仓库持续维护 | 项目已锁定 `@xyflow/react@12.11.2`；继续只负责次级图视图，不拥有领域状态 | **复用现有依赖** |
| dnd-kit | [官方仓库](https://github.com/clauderic/dnd-kit)，MIT；仓库持续维护 | core 与 sortable 会增加依赖、键盘/拖拽状态和测试面；Event 上移/下移即可满足最小重排 | **不采用** |
| React Hook Form | [官方仓库](https://github.com/react-hook-form/react-hook-form)，MIT；仓库持续维护 | 小型单屏修正表单可用 React 状态、原生表单和服务端 Zod；新增表单状态系统净增复杂度 | **不采用** |

检索日期：2026-08-13。结论：新增依赖 **none**。安全和隐私影响不扩大；所有修改请求只携带稳定 ID、结构字段与 `SourceReference`，不记录 Source 正文。真实作品页面允许用户本地阅读原文，但正文、标题、人物名、摘录、完整 Prompt、raw model output 和密钥不得进入日志、截图、公开夹具或公开报告。

## 方案比较与选择

### A. 派生队列 + Artifact review metadata（采用）

Review Queue 和 Readiness 每次从 `Source + StoryMapArtifact` 计算。人工确认与每次修正写入已有 `review_json`，并沿用 Artifact revision 链。没有新表、新事实源或迁移，刷新可恢复，旧 Artifact 不变。

### B. 持久化 ReviewTask 表（拒绝）

任务状态会与 Story Map revision 同时成为事实源，需要同步、迁移、失效和孤儿清理；本 Issue 的队列完全可以重建，不值得付出一致性成本。

### C. 浏览器本地 checklist/editor（拒绝）

实现最少，但刷新与跨 revision 后无法可靠恢复，无法为 correction-cost 留下可审计 operation metadata，也不能在服务端强制 readiness。

## 单一数据所有者

`StoryMapReviewSchema` 继续是 review metadata 的唯一结构，向后兼容地增加：

```ts
type StoryMapReview = {
  evidenceConfirmations: EvidenceConfirmation[];
  edgeEvidenceConfirmations: EdgeEvidenceConfirmation[];
  characterConfirmations: string[];
  endingCandidateConfirmations: string[];
  operation: null | {
    type: ReviewOperationType;
    timestamp: string;
    storyMapVersion: number;
  };
};
```

新增字段对旧 Artifact 使用默认空值；不修改数据库表。每个 revision 只记录产生它的一个 operation。完整 revision 链就是操作历史，避免在每个新 Artifact 中复制累积日志。生成的 v1 Artifact `operation=null`；最终确认记录 `confirm_story_map`。metadata 不包含 Source 文本、人物名、事件摘要或 Evidence 摘录。

`StoryMapRevisionChangeSchema` 是所有修正输入的单一合同：

- `update_character`：rename、aliases、role；
- `merge_characters`：一个保留人物与一个或多个被合并人物；
- `confirm_character`；
- `update_event`、`delete_event`、`add_event`、`reorder_events`；
- `delete_edge`、`add_edge`、`update_edge`、`confirm_edge_evidence`；
- `confirm_evidence`、`confirm_ending_candidate`。

Edge type 仍只允许 `causes | enables | foreshadows`。Schema 和 repository 都不做 coercion。

## Review Queue

`deriveStoryMapReview(artifact, source)` 是无 I/O 纯函数，输出稳定排序的 `queue`、`readiness` 和派生统计，不写数据库。队列项只包含目标 ID、类别、优先级、标题和可解释原因，不产生总分。

优先顺序固定为：

1. inference Event；
2. 置信度 `< 0.75` 的 Event / Edge；
3. 至少两个 alias 的人物；
4. 不同人物之间规范化 name/alias 完全碰撞的 identity merge 风险；
5. 未确认 Ending Candidate；
6. 高杠杆 divergence candidate；
7. 未确认的重要 Evidence；
8. validator soft advisory。

人物规范化只做 Unicode NFKC、trim、空白折叠和英文小写；不做 fuzzy match。identity collision 只是需要人工判断的队列项，不会自动 merge。

高杠杆 divergence 使用现有有向 Edge 图确定性计算每个 Event 可到达的后续 Event 数，按 `reachable desc → sequence asc → id asc` 取前三个正值项目，并展示其下游数量。不调用模型，不把建议写入 Story Map。

重要 Evidence 指 inference / 低置信度 Event 与低置信度 Edge 的 SourceReference。Ending Candidate 通过自己的显式核对操作覆盖；高杠杆 Event 只是分叉建议；结构合法但 `confirmed=false` 的 Edge 进入折叠 advisory，三者都不强迫用户逐条重复确认 Evidence。已确认引用按完整 SourceReference key 匹配。硬领域错误不会作为可忽略队列项：正式 Artifact 创建与每次 revision 仍由现有 validator fail closed。

## Readiness Checklist

界面明确展示：

- 关键 Event 均有合法 Evidence；
- 核心人物已核对；
- Ending Candidates 已核对；
- 无非法引用；
- 无悬空 Edge；
- 重要 Evidence 已核对；
- 当前 Story Map 可以进入 Ripple。

核心人物确定性定义为 `protagonist | antagonist`，以及参与至少两个 Event 的人物；结果只用于 Review，不改 Character Schema。`readyForRipple` 是其他项目的合取。服务端确认操作必须重新读取 Source 和最新 Artifact、重新派生 readiness，并在不满足时拒绝；disabled 按钮不是安全边界。

## 不可变修正语义

所有 change 都在事务中基于最新 Artifact 深拷贝，执行一次变换，设置下一版本与 operation，再运行 `StoryMapSchema`、`validateStoryMap` 和 `validateStoryMapReview`；全部成功才插入一个 revision。失败时不保存任何半成品。

- Character update：失效该人物确认，以及所有包含该人物 Event 的 Evidence 确认；
- Character merge：保留目标 ID，别名按“目标 aliases + 被合并人物 name/aliases”稳定去重，role/initialState 保留目标值；删除被合并人物，将所有 Event participant 重映射到目标并去重；失效所有涉及人物的确认和受影响 Event Evidence 确认；
- Event update：允许 title、summary、participants、stateChanges、evidenceKind、confidence；任何实际变化都失效该 Event Evidence 确认；
- Event delete：删除目标 Event、全部 incident Edge 和以其为 target 的 Ending Candidate，并清理相应 review confirmations；
- Event add：服务端生成新 ID，输入必须含至少一个属于当前 Source 的合法 `SourceReference`，追加后 sequence 连续；不存在无 Evidence Canon Event 路径；
- Event reorder：输入必须恰好包含当前全部 Event ID 一次，只重写连续 sequence；
- Edge add：服务端生成 ID，只连接现有 Event，输入必须含 Evidence；人工创建使用 `confidence=1`、`confirmed=false`，待单独 Evidence 确认；
- Edge update：只允许 type、explanation、evidence；实际变化失效该 Edge 的 Evidence 确认；
- Edge delete：删除 Edge 及其确认；
- Evidence / Character / Ending 确认：同样创建 revision，但按 Eval 定义不计 material revision；
- final confirm：创建 confirmed revision，重复确认同一最新版幂等；任何基于旧 revision 的提交拒绝并提示刷新。

Evidence Unit 只用于“先选 Evidence，再填写 Event/Edge”的本地 picker：复用现有 `deriveEvidenceUnits(source)` 与 `sourceReferenceForUnit`，不新建表，也不改变最终 `SourceReference[]`。

## UI

默认 `review` 视图：

- 顶部显示 revision/status、Review Queue 剩余数量和 Readiness Checklist；
- 左侧按优先级显示队列；选择一项后中间显示相关 Source Evidence，右侧显示最小修正/确认表单；
- 新增 Event/Edge 使用两步 disclosure：先选择 Source Evidence Unit，再填写结构字段；
- Event 重排使用键盘可操作的“上移/下移”，不增加拖拽依赖；
- 唯一主操作是“确认 Story Map 并进入 Ripple”，未 ready 时禁用并显示未完成项；
- “完整图”是 secondary toggle，复用现有 React Flow；图内拖动仍只改变视图，不创建 revision；
- confirmed 后主流程切换为 Ripple，已有 Worldline/Continuation 能力保持不变。

所有删除按钮描述具体目标并在界面内要求一次确认，不使用浏览器日志。Server Action 只返回脱敏通用错误；详细 Source 或 Evidence 内容不进入错误响应。

## correction-cost 记录与真实 benchmark

从 revision 链确定性汇总：

- correction type；
- revision `createdAt` 作为 timestamp；
- Story Map version；
- material revision count；
- manual Event additions。

主动 review time 不能从 revision 间隔可靠推断，仍由 `docs/evals/m1-review-template.md` 的人工计时字段记录；本 Issue 不制造埋点平台。

真实 A/B/C 复测使用同一现有生产 Artifact/revision 流程，在新的 gitignored 本地评测副本中完成，不覆盖 M1-02 run。公开报告只能使用 `Story A/B/C`、聚合计数、耗时和 PASS/FAIL，不包含 private title、人物、Event、Evidence、正文、截图或 raw output。若缺少有效人工操作计时或任一作品超门槛，M1-04 必须报告 FAIL，不用自动测试替代真实修正成本。

## 测试与停止条件

单元/合约测试至少覆盖派生优先级与 readiness、旧 Artifact 兼容、Character merge、Event add with Evidence/delete/reorder、Edge add/change/delete、确认失效、stale、final confirmed 与 operation summary。E2E 使用现有原创公开 fixture，覆盖默认队列、两步 Evidence、全部核心 correction、readiness、刷新恢复、次级完整图和进入 Ripple。

完成后运行：

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

- **M1-04 PASS**：功能、不可变语义、全量门禁和三篇真实 correction-cost 数据全部满足 M1 gate；
- **M1-04 FAIL**：任一确定性门禁失败，或三篇真实计时/修正成本数据不足或超标。实现不得因报告 FAIL 而覆盖旧 Artifact；停止，不进入下一 Issue。
