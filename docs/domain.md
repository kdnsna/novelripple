# 领域语义

本文件定义 M0 的唯一领域语言。TypeScript / Zod Schema 是它的可执行表示；两者不一致时必须在同一变更中修正。

## 事实层级

| 类型 | 含义 | 是否必须有原文证据 |
| --- | --- | --- |
| `fact` | 原文明确陈述或直接发生 | 是 |
| `inference` | 根据原文推得，但存在解释空间 | 是，并带置信度 |
| `generated` | 分歧后新世界线产生的内容 | 否，但必须追溯到 Divergence / Impact Plan |

## Source

原著及定位信息。保存 `originalText`、`normalizedText`、`contentHash` 和 section 边界。创建后不可修改；需要更换文本时创建新 Source。

Evidence Reference 使用规范化文本的 UTF-16 字符偏移：

```json
{
  "sourceId": "source_ripple_001",
  "sectionId": "section_03",
  "start": 3281,
  "end": 3412,
  "excerptHash": "sha256:..."
}
```

必须满足 `0 <= start < end <= normalizedText.length`，且切片 Hash 与 `excerptHash` 相同。

## Story Map

Story Map 是对 Source 的版本化解释，不是 Source 本身。M0 只包含：

- `characters`：稳定 ID、姓名、别名、角色和初始状态；
- `events`：顺序、标题、摘要、参与人物、状态变化、事实层级和证据；
- `edges`：`causes`、`enables`、`foreshadows`；
- `endingCandidates`：可由用户选择为 Anchor 的终局条件。

确认或修正地图会创建新 Artifact 版本，旧版本保留。

## Divergence

新世界线首次偏离父世界线的声明：

```json
{
  "eventId": "event_07",
  "type": "prevent",
  "instruction": "许澄没有交出红色账簿"
}
```

类型只有：

- `prevent`：事件不发生；
- `alternate_choice`：人物做出不同选择；
- `alternate_outcome`：事件发生但结果不同。

## Anchor

严格模式中由用户选择的终局条件。开放模式的 `anchors` 为空，但分歧前历史和未被改变的世界规则仍然有效。

Anchor 评估状态：

- `preserved`：路径和结果基本不变；
- `rerouted`：结果可保留，但必须经过新路径；
- `threatened`：现有信息不足或风险较高；
- `incompatible`：分歧与 Anchor 不能同时成立。

`incompatible` 必须阻止创建严格模式世界线，除非用户改变分歧、修改 Anchor 或切换开放模式。

## Impact Plan

模型或夹具提出的结构化候选，至少包含：

- 立即、中期与结局影响；
- 每项影响的 `reasonPath`、说明和置信度；
- 人物状态与线索变化；
- Anchor 评估；
- 不确定项。

Impact Plan 本身不修改世界线。只有用户明确确认后，才能成为 Worldline 的 `acceptedImpactPlanId`。

## Worldline

Worldline 采用“不可变基线 + 增量”：

```text
Source → Story Map version → Divergence → accepted Impact Plan → Worldline delta
```

子世界线必须显式引用：

- `parentWorldlineId`；
- `baseStoryMapArtifactId`；
- `divergence`；
- `anchors`；
- `acceptedImpactPlanId`；
- `idempotencyKey`。

同一项目内相同 `idempotencyKey` 只能创建一次。兄弟世界线不得共享分歧后的可变状态。

## Artifact 与 Generation Run

Story Map、Impact Plan 与 Continuation 都是版本化 Artifact。每个 AI 产物引用一个 Generation Run，记录 provider、model、prompt version、input hash、状态、原始输出或错误。失败运行不产生正式 Artifact。
