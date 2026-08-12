# M1 — Real Story Benchmark

本目录定义 M1 的真实作品验收集，不是第二套数据平台。M1-01 只建立分类、权利边界和 manifest contract；具体作品必须在权利确认后由后续单一 Issue 加入。

## 目录

```text
benchmarks/
├── m1/
│   ├── README.md
│   ├── manifest.schema.json
│   └── public/
│       └── README.md
└── private/                 # 整体 gitignored
    └── <story-id>/
        ├── source.txt|md
        └── manifest.json
```

公开作品加入后使用 `benchmarks/m1/public/<story-id>/source.txt|md` 与同目录 `manifest.json`。私人作品沿用相同文件约定，但整个目录不得进入 Git。

## 三类作品

| 类别 | 约束 | 主要失败风险 |
| --- | --- | --- |
| Story A：清晰线性故事 | 10k—25k 中文字符；4—6 名核心人物；明确冲突、转折、结局 | 漏掉故事脊柱或关键 Ending Candidate |
| Story B：复杂人物和时间 | 25k—45k 中文字符；8—12 名核心人物；别名、称谓、回忆、时间跳跃；至少一组易误合并人物 | identity 错误 merge、事件顺序错误、回忆当作当前事件 |
| Story C：软因果与开放结局 | 15k—35k 中文字符；动机有解释空间；开放结局；至少一个 `choice` 或 `outcome` 分叉 | 把解释当事实、把软因果写成硬因果、只会删除事件 |

Story C 的“软性 Anchor”是人工评测标签，表示结局条件存在解释空间；生产仍使用现有 strict/open mode 和 `preserved` / `rerouted` / `threatened` / `incompatible` 状态，不增加新 Anchor 类型。

至少一篇必须满足 `unseenByPromptAuthors: true`：当前 Prompt 版本冻结前，所有 NovelRipple Prompt 作者都没有阅读其正文，也没有用它调整 Prompt、Schema、Provider 配置、样例或评分阈值。运行前只允许由独立保管人核对权利、规模和 Story class；首次结果产生后才能向 Prompt 作者开放用于复盘，且该作品不得再被称为未见。

## 字符数

`characterCount` 使用 Source 规范化后的 Unicode code point 数并排除空白字符。它只决定 Benchmark 分组，不进入生产 Schema，也不改变当前 Source offset 规则。

## 权利与隐私

公共仓库只接受：

- NovelRipple 项目原创作品；
- 已进入公版的作品；
- 许可证或权利人书面授权明确允许公开再分发的作品。

每个公开 manifest 都必须记录权利类别、依据、是否允许再分发和官方来源链接（如适用）。权利不清时一律转为 private，不得先提交再补授权。

私人作品：

- 只存在于 `benchmarks/private/`；
- 不进入 Git、GitHub Actions、日志、截图、错误报告或公开夹具；
- 不把标题、人物名、事件摘要、原文片段或 raw model output 复制到提交的报告；
- 只向用户明确配置并信任的模型端点发送运行所需的最少正文。

## Manifest contract

每篇作品有一个 `manifest.json`，使用 [`manifest.schema.json`](manifest.schema.json)。至少记录：

- `id`、`title`、`rights`、`language`、`characterCount`；
- `expectedCoreCharacters` 与 `expectedSupportingCharacters`（没有 supporting character 时使用空数组）；
- `expectedKeyEvents`；
- `expectedEndingCandidates`；
- `testDivergences`。

Manifest 还记录 Story class、public/private、Source 相对路径和未见作品声明。所有数组中的稳定 ID 必须唯一；Divergence 的 `eventId` 必须引用 `expectedKeyEvents`，strict case 的 `anchorIds` 必须引用 `expectedEndingCandidates`，open case 必须没有 Anchor。JSON Schema 不建立跨数组查询层，这些引用由录入复核检查。Gold 内容只用于 Eval；模型输出仍是 candidate，人工修正仍必须通过生产 Artifact revision 完成。Manifest 不写入数据库，不成为第二套 Artifact 或 Story Map。

## 录入与评测顺序

1. 核对权利和再分发边界；
2. 规范化 Source 并计算 `characterCount`；
3. 由未参与该次生成的复核者填写 gold manifest；
4. 校验 manifest JSON 与路径；
5. 冻结本次 commit、Provider/model 与全部 Prompt 版本；
6. 运行 Story Map、strict/open Ripple 和一个 Continuation scene；
7. 使用 [`docs/evals/m1-review-template.md`](../../docs/evals/m1-review-template.md) 记录自动指标、人工修正成本、质量评分和用户观察；
8. 新运行创建新报告，旧 manifest、报告、Source、Artifact 和 Worldline 不得覆盖。
