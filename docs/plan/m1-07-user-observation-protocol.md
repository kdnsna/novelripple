# M1-07 真实用户观察协议（v1）

日期：2026-08-14
范围：M1-07 第三节——至少 3 次独立 session、至少 2 名非 NovelRipple 开发者参与者。
原则：不解释内部架构；不代操作；只记录脱敏信息，不录隐私正文。

## 环境准备（每 session 前，由小锤子完成）

1. 重置开发数据库为空库（`rm .data/dev.db && npm run db:migrate` 或使用独立 `DB_FILE_NAME` 指向新文件）。
2. 启动 dev server（`npm run dev`），确认 `http://localhost:3000` 可访问。
3. 为参与者准备：一台可用的浏览器 + 登录态（本地开发账号）。
4. 作品选择：三篇 benchmark（A/B/C）源文件路径（`benchmarks/private/m1-*/source.txt`）提供给参与者，由**参与者自己导入**。**注意**：作品是私人稿件，参与者阅读属正常使用；不复制正文到任何记录。
5. 计时工具：从"用户开始操作"到"读完一个 Continuation 场景"的记录表。

## Session 流程（对参与者）

1. 给参与者一篇作品（源文本文件，或直接提供导入路径）；
2. 不解释内部架构（不提 Story Map/Worldline/Divergence 等术语，只说"导入你的作品，看看系统能帮你做什么"）；
3. 参与者自己导入作品；
4. 参与者自己完成 Story Map review（确认/修正人物与事件）；
5. 参与者自己选择或使用系统推荐的分歧点；
6. 参与者查看 Ripple（影响预览）；
7. 参与者创建新世界线；
8. 参与者阅读 Continuation 场景；
9. 回答四个问题：
   - 原故事最重要的冲突是什么？
   - 你改变了什么？
   - 为什么后面会变化？
   - 新世界线与原作最大差别是什么？

## 记录表（脱敏）

| 字段 | 内容 |
| --- | --- |
| sessionId | user-session-01（递增） |
| participantId | P1（匿名；与真实身份无映射） |
| 作品 | Story A/B/C（不写标题） |
| 是否独立完成 | yes/no |
| 主动操作时长 | 分钟（等待/卡住不计） |
| 阻塞点 | 分类：导入/理解/修正/选择/生成/阅读/其他 |
| 错误理解 | 简述（脱敏，不提具体内容） |
| 是否需要开发者代操作 | yes/no + 哪一步 |
| 是否愿意继续使用 | yes/no |

## 四问记录

| 问题 | 回答摘要（脱敏） |
| --- | --- |
| 原故事最重要的冲突是什么？ | |
| 你改变了什么？ | |
| 为什么后面会变化？ | |
| 新世界线与原作最大差别是什么？ | |

## 完成条件与输入

- 每次观察完成后把脱敏记录写入 `novelripple-m1-review-kit/m1-07-user-observations/user-session-<编号>.json`（格式见下）。
- 3 次 session 完成后汇总为 `users.json` 输入 `npm run eval:m1`（字段：sessionCount、nonDeveloperParticipantCount、sessions[]）。

```json
{
  "sessionCount": 3,
  "nonDeveloperParticipantCount": 2,
  "sessions": [
    {
      "sessionId": "user-session-01",
      "participantId": "P1",
      "independentCompletion": true,
      "blockerCategories": [],
      "wouldUseAgain": true
    }
  ]
}
```

## 隐私红线

- 不记录参与者姓名、联系方式、录屏、截图；
- 不记录作品正文、人物名、事件内容、场景文本；
- 只记录上表的脱敏字段与四问的脱敏摘要（不含具体人名/情节）。
