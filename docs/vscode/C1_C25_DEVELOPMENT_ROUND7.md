# C1–C25 开发记录（第七轮）：R1.1 companion 活动查询

开发日期：2026-11-17（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R1.1：让 companion 报告真实 Agents、终端与包操作，扩展的重启检查在拿不到答案时显示未知并拒绝，而不是当作空闲。R1.2（停机窗口内阻止新任务）、R1.3（页面重建后的待生效状态）与 R1.4 的完整用例矩阵仍未完成。前几轮见[第六轮](C1_C25_DEVELOPMENT_ROUND6.md)等记录。

## 结论

重启前的工作检查不再把 companion 的活动当成“看不见所以没有”：扩展通过新帧询问 companion，回答 running turns、running terminals 与 package operations；查询失败、超时或没有可问的进程时，guard 返回“这个窗口无法查询的工作”，破坏性重启被拒绝。

## 修改

| 文件 | 变化 |
| --- | --- |
| [companion/main.ts](../../apps/vscode/src/companion/main.ts) | 新增 `activity-query` 帧与 `hostActivity`：读取 `agents.list()`（status 为 running 的数量）与 `terminals.list(agent)`，并用 `plugin-manager/operation` 事件维护 started/settled 的包操作集合；以 `activity-result` 回答 |
| [companion-bridge.ts](../../apps/vscode/src/host/companion-bridge.ts) | 新增 `CompanionActivity`、`activity(timeoutMs = 2000)`、帧校验（三个计数都是非负整数）；退出、错误或 dispose 时以原因拒绝所有未决查询 |
| [host.ts](../../apps/vscode/src/host/host.ts) | `companionActivity()`：companion 模式转发查询；非 companion 或未启动返回 undefined（表示“无法回答”，不是空闲） |
| [extension.ts](../../apps/vscode/src/extension.ts) | `RestartActivityMonitor` 的 `activity()`/`blockers()` 改为异步；companion 计数与本窗口集成的 DSH 终端相加；查询抛错或返回 undefined 时 `blockers()` 返回 `a turn or package operation this window cannot query (...)`，`guardedRestart` 与工作区切换都 `await` 该判断 |
| [package.json](../../apps/vscode/package.json) | 增加仅类型用的 `@deepseek-ai/dsh-plugin-manager` devDependency，用于 `plugin-manager/operation` 的事件声明合并（运行时无该依赖） |

## 回归用例

- [companion-response.spec.ts](../../apps/vscode/tests/companion-response.spec.ts)：companion 回答 `{runningTurns:2, packageOperations:1, runningTerminals:3}` 时 `bridge.activity()` 原样返回；companion 不回答时以“did not answer”拒绝，不会返回零。
- [restart.spec.ts](../../apps/vscode/tests/restart.spec.ts)：原有计数用例改为异步并保持断言；新增“companion 报告 + 本窗口集成终端相加”“查询失败时拒绝并说明原因”“既无 context 也无 companion 时报告无法查询”三个用例。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest`（apps/vscode 全量） | 28 文件、271 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit`（apps/vscode） | exit 0 |
| `pnpm exec tsdown`（apps/vscode） | 构建成功，exit 0；`lib/companion.cjs` 内含 `activity-query`/`activity-result` |
| `pnpm install --ignore-scripts` | 链接新增 devDependency，exit 0（无下载） |

## 仍未验证

- R1.2：还没有“停在确认与停机之间阻止新 turn/包操作”的协调；当前仍是先查一次再停机，窗口内新任务未被阻止。
- R1.3：pendingRestart 仍是 controller 内存状态，页面重建后未向 Host 重新取待生效状态。
- R1.4：缺 page rebuild、替换→开关往返、成功/失败重启、companion 正在安装包等组合用例。
- 未跑真实 GUI/双窗口；R2.2/R2.4/R2.6、R3、R4.2/R4.3、R8 未完成；C9/C10 维持暂缓。
