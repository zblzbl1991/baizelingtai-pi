# 工单系统：本地 Markdown

规格、地图和工单保存在 `.scratch/<feature>/`：
- `spec.md`：功能规格；已有公开设计时引用原文，保持单一事实来源。
- `map.md`：Notes、Decisions-so-far、Fog 与工单导航。
- `issues/NN-<slug>.md`：每张工单一个文件，从 01 编号。

## 状态与依赖

- `Type:` 使用 research、prototype、grilling 或 task。
- `Status:` 使用 open、claimed、resolved。
- `Labels:` 保存类别及分诊标签，映射见 triage-labels.md。
- `Blocked by:` 列出同功能阻塞工单编号；无依赖写 none。
- 仅当全部前置工单已解决且满足依赖条件，当前工单才能开工。
- 从未认领、未解决且无阻塞的工单中，按编号选择下一张。
- 开工前先保存 `Status: claimed`。
- 完成后在 `## Answer` 记录结果、验证和提交，再设为 resolved，并向地图追加结论与链接。
- 评论追加到 `## Comments`，保留已有历史。

“发布工单”表示创建本地文件；“关闭工单”按上述完成约定执行。
源码完成、验收、部署和发布分别记录。现有工单不自动迁移。
