# C1–C25 开发记录（第九轮）：R2.6 hostProvided 可满足性

开发日期：2026-11-17（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R2.6：不再只接受包自报的 `hostProvided`，而在安装前检查这份来源是否真的存在。前几轮见[第八轮](C1_C25_DEVELOPMENT_ROUND8.md)。

## 结论

读取器新增可选的安装上下文：调用方传入“这个安装是否提供某个包名”的查询后，`hostProvided` 里的每个名字都必须在**本次启动的安装目录内**解析到；否则闭包记为 `not-proven`，安装会在 pnpm 运行前被拒绝，并写明是哪个包缺失。查询本身仍区分“记录没写”和“安装没提供”。

## 修改

| 文件 | 变化 |
| --- | --- |
| [local-bundle.ts](../../packages/boot/plugin-manager/src/local-bundle.ts) | 新增 `PreparedBundleContext { supplies(name) }` 与 `readPreparedBundle(kind, path, context?)`；`availabilityProblems` 对每个 hostProvided 名字产生 `is host-provided, but the installation does not supply it` |
| [index.ts](../../packages/boot/plugin-manager/src/index.ts) | `preparedContext()` 提供查询；`installationSupplies(name)` 从 profile 的 `installAnchor` 解析，并要求结果位于该安装目录内（祖先 `node_modules` 或开发 checkout 不算）；inspect 与 install 都带上该上下文 |
| [README.md](../../packages/boot/plugin-manager/README.md) | 说明 hostProvided 的实际可满足性检查与拒绝时机 |

## 回归用例

- [local-bundle.spec.ts](../../packages/boot/plugin-manager/tests/local-bundle.spec.ts)：无上下文时保持 proven（兼容不掌握安装的调用方）；`supplies: () => false` 时 not-proven 且带原因；`supplies: () => true` 时 proven。
- [manager.spec.ts](../../packages/boot/plugin-manager/tests/manager.spec.ts)：准备包声明 `hostProvided: ['@deepseek-ai/cordis']` 而测试安装不提供它时，install 在 pnpm 之前失败，诊断包含该原因，profile 依赖保持原样。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| plugin-manager `local-bundle.spec.ts` | 40 测试通过，exit 0 |
| plugin-manager `manager.spec.ts` + `tools.spec.ts` | 2 文件、212 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit`（plugin-manager） | exit 0 |

## 仍未验证

- R2.2：真实离线 store 闭环与空 store、无网络、仓库外 profile 的 fixture 仍未做；`offline: proven` 仍不代表 store 就绪。
- R2.4：VS Code 本地导入的离线政策未实现。
- peer 的实际可满足性依赖既有规则（closure 成员或 hostProvided），hostProvided 已做安装检查；没有单独的“peer 由全局环境满足”路径。
- R1.3/R1.4、R3、R4.2/R4.3、R8 未完成；真实 GUI、候选 VSIX、真实公司网关未验证；C9/C10 维持暂缓。
