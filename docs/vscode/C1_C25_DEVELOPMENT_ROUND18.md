# C1–C25 开发记录（第十八轮）：R2.2 store 预检与候选复建

开发日期：2026-11-18（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R2.2 前半：安装/修复前校验目标 pnpm store 是否仍然存在。真实的“空 store、无网络、仓库外 profile”离线 fixture 仍未建立。前一轮见[第十七轮](C1_C25_DEVELOPMENT_ROUND17.md)。

## 结论

pnpm 会在 `node_modules/.modules.yaml` 里记录本次安装使用的 store。读取该记录后，如果记录的 store 目录已不存在，修复会在运行 pnpm 之前直接报告 `offline-store`，proven 的离线安装也会在 pnpm 之前被拒绝并点名缺失路径。这补上了“先证明元数据、再发现 store 没了才失败”的落差，但**不代表**已在空 store/无网络环境完成真实安装。

## 修改

| 文件 | 变化 |
| --- | --- |
| [operations.ts](../../packages/boot/plugin-manager/src/operations.ts) | 新增 `recordedStoreDir(dir)`（读 `.modules.yaml` 的 `storeDir`）与 `missingRecordedStore(dir)`（记录存在但目录缺失时返回该路径） |
| [index.ts](../../packages/boot/plugin-manager/src/index.ts) | `repairLocked` 在 pnpm 之前预检并返回 `offline-store` 诊断；`installBundle` 的 proven 离线分支在 pnpm 之前拒绝并点名 store |

## 回归用例（[manager.spec.ts](../../packages/boot/plugin-manager/tests/manager.spec.ts)）

- “refuses a store repair when the recorded pnpm store is gone”：写入缺失的 `storeDir`，断言 `problem: 'offline-store'`、诊断含“does not exist”、pnpm 未被调用、profile 依赖未变。
- “refuses a proven prepared install when the recorded pnpm store is gone”：proven 准备包 + 缺失 store，断言 install 在 pnpm 之前失败、诊断含 `recorded pnpm store`。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| plugin-manager `manager` + `operations` + `tools` | 3 文件、290 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit`（plugin-manager） | exit 0 |
| `DSH_CLIENT_COMMIT_HASH=0000000 pnpm run build:artifacts` | 8/8 gate，145s，exit 0 |
| 同标记 `pnpm run build:check` | 2/2（client 33.0s、host 100.6s），exit 0 |
| `runtime:standalone` | exit 0（重新 staging，运行时含本次预检） |
| `package:standalone` + 解包复验 | exit 0；35,925 条目；8 项标记、Office、随包 pnpm、companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,034,217 字节，SHA-256 `395aad9561407f726306c6c9371f911c5907514e37d3b66f0347abf3aee4c063`；运行时 `dsh-plugin-manager/lib/index.js` 已含 “recorded pnpm store” 文案。第十七轮的 `eb9143…` 因运行时重新 staging 作废；构建仍用合成标记 `0000000`，不对应 Git 修订。

过程记录：只重跑 `package:standalone` 时哈希不变（`eb9143…`），说明 VSIX 打包的是既有的 `apps/vscode/runtime` 而不是新构建；补跑 `runtime:standalone` 后哈希才变化。这一点对后续 R8 复验很重要。

## 仍未验证

- R2.2 的核心仍缺：空 store、无网络、仓库外 profile 的真实本地安装 fixture；本轮只做“记录过的 store 已消失”这一种预检。
- R2.4（本地导入离线政策）、R3 页面动作与 fixture、R1.2 准入与 R1.3 待生效状态、R4.3 的 UI 一半、R6.5/6.6 未完成；真实公司网关、真实 VS Code 安装、双窗口未验证；C9/C10 维持暂缓。
