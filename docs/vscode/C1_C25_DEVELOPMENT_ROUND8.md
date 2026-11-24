# C1–C25 开发记录（第八轮）：R1.2 停机前二次确认

开发日期：2026-11-17（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R1.2 前半：把最后一次确认放到拥有进程状态的 Host 里、紧挨停机执行，缩小“先查一次、异步停机期间新任务进入”的窗口。**真正阻止停机窗口内新任务的应用内准入仍未实现**，因此 R1.2 只算部分完成。前几轮见[第七轮](C1_C25_DEVELOPMENT_ROUND7.md)。

## 结论

`DshHost.restart()` 在停止 companion 之前会再问一次它的活动；仍报告运行中的 turn/包操作/终端时直接拒绝，运行中的应用完全不动。此前只有扩展侧的一次检查，检查与 `stop()` 之间隔着异步工作。

## 修改

| 文件 | 变化 |
| --- | --- |
| [host.ts](../../apps/vscode/src/host/host.ts) | `restart()` 先 `restartRefusal(await companionActivity())`，拒绝时不准备启动、不停机；新增导出的 `restartRefusal(activity)` 把三类工作写成单复数正确的说明；`companionActivity()` 只在 `ready` 状态询问——崩溃或已停止的 host 没有可中断的工作，重启不被误拒 |
| [host-lifecycle.spec.ts](../../apps/vscode/tests/host-lifecycle.spec.ts) | 主机 mock 增加 `activity`；新增“companion 仍报告 2 个 turn、1 个包操作时拒绝重启且保持 ready、不增加启动/销毁次数”；新增 `restartRefusal` 的 undefined/零值放行与三类工作文案用例 |
| [workspace.spec.ts](../../apps/vscode/tests/workspace.spec.ts) | 主机 mock 增加“无运行工作”的 `activity`，说明工作区用例不覆盖重启拒绝 |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest`（apps/vscode 全量） | 28 文件、274 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `pnpm exec tsdown` | 构建成功，exit 0 |

## 仍未验证

- R1.2 的真正准入：查询与停机之间仍可开始新的 turn/包操作；应用内“停机中拒绝新任务”的开关与等待/拒绝语义未实现。
- R1.3：pendingRestart 仍是 controller 内存状态，页面重建后未向 Host 重取。
- R1.4：缺页面重建、替换→开关往返、成功/失败重启的组合用例。
- R2.2/R2.4/R2.6、R3、R4.2/R4.3、R8 未完成；真实 GUI/双窗口、候选 VSIX、真实公司网关未验证；C9/C10 维持暂缓。
