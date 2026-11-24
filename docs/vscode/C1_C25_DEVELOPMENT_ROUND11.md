# C1–C25 开发记录（第十一轮）：R3.2 修复失败时指明来源

开发日期：2026-11-17（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R3.2 中“明确显示为何 store 修复不可用”的后端部分：本地、link、git 来源不再只得到一句笼统说明，而是带上 lockfile 记录的 specifier，调用方据此提供“从该来源重装”的动作。本轮没有修改页面上的修复入口。前几轮见[第九轮](C1_C25_DEVELOPMENT_ROUND9.md)与[交接记录](READINESS_HANDOFF.md)。

## 结论

`repairBundle` 对没有精确版本的依赖返回 `unrecorded-version` 时，诊断现在会写出 lockfile importer 记录的 specifier（例如 `file:/abs/path`、`link:../pkg`、`git+https://…`），并说明应从该来源重装而不是做 store 修复。原来同一句话并列四种来源，用户无法知道自己该重新导入哪个包。

## 修改

| 文件 | 变化 |
| --- | --- |
| [operations.ts](../../packages/boot/plugin-manager/src/operations.ts) | `RecordedDependency` 新增可选 `specifier`，从 lockfile importer 的 `specifier` 字段读出；有精确版本时也一并返回 |
| [index.ts](../../packages/boot/plugin-manager/src/index.ts) | `repairLocked` 的 `unrecorded-version` 诊断追加 `. The lockfile records <specifier>; reinstall the package from that source instead of a store repair` |
| [README.md](../../packages/boot/plugin-manager/README.md) | 说明 `unrecorded-version` 会指明 specifier |

## 回归用例

[manager.spec.ts](../../packages/boot/plugin-manager/tests/manager.spec.ts) 的“records without an exact version”用例新增两条断言：诊断包含 lockfile 记录的 `file:extra`，以及“从该来源重装”的指引；既有“no exact version”与“未调用 pnpm”保持。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| plugin-manager `manager` + `operations` + `tools` | 3 文件、288 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit`（plugin-manager） | exit 0 |

## 仍未验证

- R3.2 的页面动作：Plugins 页仍只提供“Repair”（store 修复），没有“选择完整本地包修复”的入口；本轮只让原因可读、可据以引导。
- R3.3/R3.4：结构化诊断折叠、修复后回到同一入口、fixture 矩阵未做。
- R1.3/R1.4、R2.2/R2.4、R4.2/R4.3、R8 未完成；真实 GUI、候选 VSIX、真实公司网关未验证；C9/C10 维持暂缓。
