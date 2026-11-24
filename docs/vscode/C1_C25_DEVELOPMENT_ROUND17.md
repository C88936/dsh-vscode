# C1–C25 开发记录（第十七轮）：R1.1 活动统计可测化

开发日期：2026-11-18（Asia/Shanghai）。范围：R1.1/R1.4 的回归覆盖——把 companion 的活动统计从入口文件里抽成独立模块并补单元测试。前几轮见[第十六轮](C1_C25_DEVELOPMENT_ROUND16.md)。

## 结论

`hostActivity` 之前只存在于 `companion/main.ts`，无法单独测试，R1.1 的“turn/终端/包操作计数”只有间接证据。现在它位于 `companion/activity.ts`，用三个用例覆盖：多 Agent 下只计 running turn、终端按各自 Agent 统计且与 turn 状态无关、未挂载服务计零。行为不变，companion 入口只改为引用该模块。

## 修改

| 文件 | 变化 |
| --- | --- |
| [activity.ts](../../apps/vscode/src/companion/activity.ts) | 新增：`HostActivity` 与 `hostActivity(get, packageOperations)`，说明“未挂载的服务计零，终端与 turn 无关” |
| [main.ts](../../apps/vscode/src/companion/main.ts) | 删除内联实现，改为从 `./activity.ts` 导入；`activity-query` 的应答保持不变 |
| [companion-activity.spec.ts](../../apps/vscode/tests/companion-activity.spec.ts) | 新增 3 个用例（多 Agent/终端/包操作、两个服务都缺失、只有 agents） |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest companion-activity + companion-response` | 2 文件、9 测试通过，exit 0 |
| `vitest`（apps/vscode 全量） | 33 文件、296 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `tsdown` | 构建成功，exit 0 |
| `package:standalone` + 解包复验 | exit 0；35,925 条目；8 项标记、Office、随包 pnpm、companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,031,821 字节，SHA-256 `eb9143013b6c2056944cf58166a3747bc9440ef8fd814cacd5c61a0b2a7b4a84`；第十五轮的 `d1c461f5…` 因本次源码变化作废。

## 仍未验证

- R1.2 的真正准入（停机窗口中拒绝新任务）未实现；R1.3（页面重建后的待生效状态）需要专门的 Host 查询与 Typert 重新生成，未做；R1.4 的 GUI 场景（页面重建、替换→开关往返）未验证。
- R2.2/R2.4、R3 的页面动作与 fixture、R4.3 的 UI 一半、R6.5/6.6 未完成；真实公司网关、真实 VS Code 安装、双窗口未验证；C9/C10 维持暂缓。
