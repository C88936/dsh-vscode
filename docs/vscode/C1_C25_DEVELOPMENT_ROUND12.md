# C1–C25 开发记录（第十二轮）：R8 统一重建与候选 VSIX

开发日期：2026-11-17（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R8：用当前源码统一构建、准备独立运行时、重打候选 VSIX，并在仓库外解包验证。前几轮见[第十一轮](C1_C25_DEVELOPMENT_ROUND11.md)。

## 结论

本批源码现在能完整构建并通过聚合类型检查；独立运行时（Node、pnpm、Office payload）就绪；候选 VSIX 已用当前源码重打，哈希为 `ceef6711629cdef09a3d0b80c5afc31e026d762712dd6866d07b5bd81f8273ef`（256,994,156 字节，35,923 条目），在仓库外解包后确认包含公司首次配置、模型写回、占位模型、companion 活动查询、transport 关闭、Request 归一化与本轮资源枚举修复，packaged companion 在隔离 home、空 PATH、随包 Node 下启动成功。旧候选（`1f04c4c0…`）不再代表当前源码。

本轮使用**合成构建标记** `DSH_CLIENT_COMMIT_HASH=0000000`：该 checkout 没有 `.git`，`build:artifacts` 会先执行 `git rev-parse HEAD` 而失败。`0000000` 是仓库已有的合成变量取值，不是提交、不能当作可追溯版本。

## 执行与结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 无标记尝试 | `pnpm run build:artifacts` | exit 1：`Command failed: git rev-parse HEAD`（无 `.git`），未开始构建 |
| 聚合构建 | `DSH_CLIENT_COMMIT_HASH=0000000 pnpm run build:artifacts` | 8/8 gate 通过（native、Host Typert、host compiler、Host bundle、Desktop bundle、client compiler、Client bundle、Web build），183s，exit 0；记录 362 个 client artifact |
| 聚合类型检查 | `DSH_CLIENT_COMMIT_HASH=0000000 pnpm run build:check` | 2/2 通过（client 8.3s、host 29.1s），exit 0；首次失败，原因是 `components.client.spec.tsx` 的 prepared fixture 缺少 R2.1 新增的 `store`/`loadable`，补齐后通过 |
| 独立运行时 | `pnpm run runtime:standalone`（apps/vscode） | exit 0；staged companion 完成 profile 初始化、settings RPC、会话可见、workspace 绑定；输出 `standalone runtime ready` |
| 候选 VSIX | `pnpm run package:standalone`（apps/vscode） | exit 0；`packaged 35923 files -> apps/vscode/dsh-vscode.vsix (245 MB)` |
| 候选验证 | `node .tmp/r8-candidate-smoke.mjs` | exit 0；见下表 |

候选验证（`.tmp/r8-candidate-smoke.json`）：

| 检查 | 结果 |
| --- | --- |
| 包内 `lib/extension.cjs` | 含 `configureCompany`、`set-provider-model`、`dsh-unconfigured-model`、`writeEffectiveSetting` |
| 包内 `lib/companion.cjs` | 含 `activity-query`、`activity-result` |
| 包内 `lib/webview.iife.js` | 含 `transport/closed`、`normalizeRequest` |
| 运行时 `dsh-client-modules/lib/index.js` | 含本轮修正后的 `cannot be enumerated` |
| 运行时记录 | `pnpmEntry = node_modules/pnpm/bin/pnpm.mjs`，Node 可执行文件 92,825,416 字节，Office payload `present` |
| packaged companion smoke | 隔离 `DSH_HOME`、空 `PATH`、随包 Node：settings RPC 200、settings mutate success、session visible、workspace bound |

证据文件：`.tmp/r8-build-artifacts-2.log`、`.tmp/r8-build-check-2.log`、`.tmp/r8-build-check.log`（首次失败）、`.tmp/r8-runtime-standalone.log`、`.tmp/r8-package-vsix.log`、`.tmp/r8-candidate-smoke.json`、`.tmp/r8-candidate-smoke.log`。

## 仍未验证

- R8.4 的 mock 公司网关流程（配置→发现→候选→选择→有效值→overlay→重启）没有对候选包执行；R4.2/R4.3 本身也未实现。
- 没有真实 VS Code 安装运行、没有真实公司网关、没有双窗口实机；这些仍需部署环境。
- 候选包内的 Webview 资源/上传/取消只由构建产物 smoke 与单元测试覆盖，未在真实 VS Code Webview 中点击验证。
- 合成标记 `0000000` 不是实提交；本候选不能宣称对应某个 Git 修订。
- R1.3/R1.4、R2.2/R2.4、R3 的页面动作与 fixture、R4.2/R4.3 仍未完成；C9/C10 维持暂缓。
