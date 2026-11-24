# C1–C25 开发记录（第二十四轮）：R1.3 客户端采纳 Host 待生效状态

开发日期：2026-11-18（Asia/Shanghai）。范围：R1.3 的客户端一半——页面重建后从上一轮新增的 `pendingRestartBundles()` 恢复“已保存但运行代次未加载”的开关差异横幅。前一轮见[第二十三轮](C1_C25_DEVELOPMENT_ROUND23.md)。

## 结论

Plugins 页每次加载列表后会向 Host 查询待生效的 bundle 差异，并把它合并进页面自己的待重启记录：重建后的页面能重新显示 toggle 差异横幅，而不再只依赖本页内存。查询被拒绝或返回空时保持原状，不虚构提示；Host 没有记录的“保存文件变化”仍不会出现在横幅里。

## 修改

| 文件 | 变化 |
| --- | --- |
| [manager-store.ts](../../packages/client/ui-plugin-manager/src/client/manager-store.ts) | 列表加载后调用 `adoptHostPendingRestart()`：读取 `pendingRestartBundles()`，只为尚未跟踪的名字补一条 `{runtimeEnabled, savedEnabled}` 记录并发布；拒绝或异常时静默保留页面记录 |
| [manager-store.client.spec.ts](../../packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts) | bench 的 remote fake 增加 `pendingRestartBundles`（默认返回空）；新增“重建后恢复差异横幅（change: enabled）”与“Host 返回空/拒绝时保持为空且状态 ready”两个用例 |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest manager-store.client.spec.ts` | 166 测试通过，exit 0 |
| `tsc -p packages/client/ui-plugin-manager/tsconfig.client.json --noEmit` | exit 0（生成的 remote 类型已含新方法） |
| `build:artifacts`（合成标记 `0000000`） | 8/8，130s，exit 0 |
| `build:check` | 2/2，97s，exit 0 |
| `runtime:standalone` + `package:standalone` | exit 0，35,927 条目 |
| 候选解包复验 | exit 0，8 项标记、Office、随包 pnpm、packaged companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,092,929 字节，SHA-256 `adfd818ecae5c87e59d8dbbdc92926d44ce411b1a82db3bef2c01da95eb89c7b`；第二十三轮的 `c9e92578…` 作废。构建仍用合成标记 `0000000`，不对应 Git 修订。

## 仍未验证

- 浏览器里的实际横幅渲染未截图验证；页面重建只由 store 单测覆盖。
- 保存的文件变化（install/replace/remove）仍未与运行代次绑定持久化，重建后不会恢复这类提示。
- R1.2 应用内准入、R1.4 GUI 矩阵、R2.2 真实离线 fixture、R2.4、R3 页面动作、R4.3 的 UI 一半、R6.5/6.6 未完成；真实公司网关/GUI/双窗口未验证；C9/C10 维持暂缓。
