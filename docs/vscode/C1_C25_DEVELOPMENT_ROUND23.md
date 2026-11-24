# C1–C25 开发记录（第二十三轮）：R1.3 Host 侧待生效查询

开发日期：2026-11-18（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R1.3 前半：Host 现在能回答“已保存但运行代次尚未加载的 bundle 选择”，页面重建后不必只靠自身内存。客户端采纳该答案仍未接入。前一轮见[第二十轮](C1_C25_DEVELOPMENT_ROUND20.md)。

## 结论

`PluginManager` 新增 `@Remote pendingRestartBundles()`，比较 profile 当前保存的 bundle 选择与本次运行启动时的选择，返回有差异的条目（`runningEnabled` / `savedEnabled`）。这正是 toggle 差异的 Host 事实来源；保存的文件变化仍未记录，注释里写明不虚构该结论。Typert 由 `build:artifacts` 重新生成。

## 修改

| 文件 | 变化 |
| --- | --- |
| [types.ts](../../packages/boot/plugin-manager/src/types.ts) | 新增 `BundlePendingRestart { name, runningEnabled, savedEnabled }` |
| [index.ts](../../packages/boot/plugin-manager/src/index.ts) | 新增 `@Remote async pendingRestartBundles()`：并集、排序、仅返回差异；说明文件变化不在其中 |
| [manager.spec.ts](../../packages/boot/plugin-manager/tests/manager.spec.ts) | 新增用例：启动后无差异；清空保存的选择后返回 `core`、`extra` 两条 `runningEnabled: true, savedEnabled: false` |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| plugin-manager `manager` + `tools` | 2 文件、215 测试通过，exit 0 |
| `tsc -p packages/boot/plugin-manager/tsconfig.json --noEmit` | exit 0 |
| `DSH_CLIENT_COMMIT_HASH=0000000 pnpm run build:artifacts` | 8/8 gate，158s，exit 0（含 Typert 生成） |
| 同标记 `pnpm run build:check` | 2/2，188s，exit 0 |
| `runtime:standalone` + `package:standalone` | exit 0，35,927 条目 |
| 候选解包复验 | exit 0，8 项标记、Office、随包 pnpm、packaged companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,092,491 字节，SHA-256 `c9e92578ee5986345ffc2d99796dbf4df0525e8e4e315deef3f77bffe1e8adde`；第二十轮的 `be03a47…` 作废。构建仍用合成标记 `0000000`，不对应 Git 修订。

过程记录：解包验证时遇到 `ENOSPC`（C: 仅剩 2.5 GB，历史 smoke 抽取目录累计约 7.6 GB）；清理后成功，并给 `.tmp/r8-candidate-smoke.mjs` 增加了抽取后自动删除，避免再次占满磁盘。

## 仍未验证

- 客户端尚未调用 `pendingRestartBundles()`：页面重建后仍不会自动恢复 toggle 差异横幅；这是 R1.3 的下一半，需要客户端 store 接入与 locale 文案。
- 保存的文件变化（install/replace/remove）仍未与运行代次绑定持久化，Host 查询不包含它们。
- R1.2 应用内准入、R1.4 GUI 矩阵、R2.2 真实离线 fixture、R2.4、R3 页面动作、R4.3 的 UI 一半、R6.5/6.6 未完成；真实公司网关/GUI/双窗口未验证；C9/C10 维持暂缓。
