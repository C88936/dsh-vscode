# C1–C25 开发记录（第二十轮）：R1.2 停机前冻结页面

开发日期：2026-11-18（Asia/Shanghai）。范围：R1.2 的“阻止停机窗口内新任务”——在确认与停机之间先关闭页面的 Host transport，让新提交以“传输已关闭”失败，而不是在停机中被中断。前一轮见[第十八轮](C1_C25_DEVELOPMENT_ROUND18.md)。

## 结论

`guardedRestart` 现在按“检查运行工作 → 关闭页面 transport → 停止 Host → 重绘”的顺序执行；工作区切换复用同一路径。关闭后页面无法再发起新请求，迟到提交得到结构化关闭错误；重启失败时会先重绘出可用页面再报告失败，不会留下一个死页面。这仍不是应用内准入（companion 自身仍可能收到其他来源的新工作），但把 UI 来源的窗口收紧到接近零。

## 修改

| 文件 | 变化 |
| --- | --- |
| [chat-view.ts](../../apps/vscode/src/view/chat-view.ts) | 新增 `freezeTransport(reason)`：向页面发送 `transport-reset`（`deliberate: true`），失败只记日志 |
| [extension.ts](../../apps/vscode/src/extension.ts) | `guardedRestart` 在 `dsh.restart()` 之前 `await view.freezeTransport('DSH is restarting')`；重启失败时先 `view.refresh()` 恢复页面，再抛出 |
| 测试 | [restart.spec.ts](../../apps/vscode/tests/restart.spec.ts) 新增“关闭传输先于停止 Host”的调用顺序断言；失败路径断言页面被重绘；[workspace.spec.ts](../../apps/vscode/tests/workspace.spec.ts)、[company-setup.spec.ts](../../apps/vscode/tests/company-setup.spec.ts) 的 view doubles 补 `freezeTransport`，失败路径的 `refresh` 断言改为“必须重绘” |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest`（apps/vscode 全量） | 37 文件、317 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `tsdown` | 构建成功，exit 0 |
| `package:standalone` + 解包复验 | exit 0；35,927 条目；8 项标记、Office、随包 pnpm、companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,070,774 字节，SHA-256 `be03a474e28ec972ae655371073f468759d69f0aa23512f8a376830c3f6791b0`；第十八轮的 `395aad95…` 作废。构建仍用合成标记 `0000000`，不对应 Git 修订。

## 仍未验证

- 应用内准入仍未实现：companion 自身或其他窗口来源的新工作不受该冻结影响；R1.2 只覆盖本窗口 UI 来源。
- 冻结后的页面对用户可见的影响（点击发送得到关闭错误）未在 GUI 中验证；R1.4 的页面重建/替换往返场景仍未做。
- R1.3、R2.2 真实离线 fixture、R2.4、R3 页面动作、R4.3 的 UI 一半、R6.5/6.6 未完成；真实公司网关、真实 VS Code 安装、双窗口未验证；C9/C10 维持暂缓。
