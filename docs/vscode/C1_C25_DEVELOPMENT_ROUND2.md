# C1–C25 开发记录（第二轮）：R2 内容绑定与候选管理行

开发日期：2026-11-17（Asia/Shanghai）。范围：继续 [C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R2，本轮完成 R2.3（inspect 与实际安装内容绑定）和 R2.5 的本地候选管理行预检；R2.1、R2.2、R2.4 未实施。上一轮见 [R5/R7 与 R6 记录](C1_C25_DEVELOPMENT_ROUND1.md)。

## 结论

第一轮验收复现的“改 index.js 后 fingerprint 不变”已修复，验收自带探针现在输出 `sameFingerprint: false`。本地候选在 pnpm 运行前会读取自己声明的 patch 行，新名字包无法靠包名躲过管理权检查。离线闭环（pnpm store 证明）、状态拆分和本地导入离线政策仍缺。

## R2.3：inspect 绑定实际安装内容

原缺陷（验收复现）：`fingerprint` 只覆盖 `package.json` 与 `dsh-prepared-bundle.json`，同路径改 `index.js`、脚本或依赖文件后指纹不变，`checkPreparedExpectation` 也就无法发现 inspect 与安装之间被替换的内容。

修改（[local-bundle.ts](../../packages/boot/plugin-manager/src/local-bundle.ts)）：

| 行为 | 说明 |
| --- | --- |
| 目录内容摘要 | 递归遍历包目录，按名称排序、以 `/` 分隔记录每个条目；文件记录相对路径、字节长度和内容，符号链接记录目标而不跟随 |
| 归档内容摘要 | 对整个归档文件字节求 SHA-256，覆盖归档内任何条目的改动 |
| 指纹组合 | `sha256('dsh-prepared-content/v1' + 内容摘要 + package.json + 记录)`，方案名参与哈希，旧方案指纹不会与新方案误判相等 |
| 越界拒绝 | 目录超过 50,000 个条目或 1 GiB 时拒绝整包（`not-a-package`），不做部分摘要，避免两个不同包比较相等 |

回归用例（[local-bundle.spec.ts](../../packages/boot/plugin-manager/tests/local-bundle.spec.ts)）：改 `index.js`、改依赖 `package.json`、新增文件、重建归档时指纹都变化，且元数据仍为 `proven`（说明检测依靠内容指纹而非元数据）；验收探针 `.tmp/c1-c25-fingerprint-probe.mjs` 现输出 `{"before":"proven","after":"proven","sameFingerprint":false}`。

## R2.5：运行 pnpm 前检查候选自己的管理行

原缺陷：`protectsManager(name)` 只能读取已安装包的 patch 行；profile 不认识的新名字包若在自己的 patch 里挂载 `@deepseek-ai/dsh-plugin-manager` 或管理入口的 `include:`，安装前的包名检查看不到。

修改：

- `local-bundle.ts` 新增 `readLocalBundleEntries(kind, path)`：按 `dsh.bundle.patch` 声明读取候选（目录或归档内）的 patch 文件，解析 YAML 并收集 `insert` 行的 `id`/`name`；拒绝越出包内的路径，报告缺失文件与不可读 YAML。
- `index.ts` 的 `installBundle` 在 pnpm 之前比对：命中 `PROTECTED_PLUGINS` 或当前管理入口的 `include:<id>` 就以 `management-required` 拒绝。读不出 patch 时不算所有权信号，交给启动时的 bundle 加载诊断（读不出的 patch 无法挂载管理服务）。

回归用例：[local-bundle.spec.ts](../../packages/boot/plugin-manager/tests/local-bundle.spec.ts) 覆盖目录/归档读取、缺失 patch、非法声明、无 `insert` 的包；[manager.spec.ts](../../packages/boot/plugin-manager/tests/manager.spec.ts) 新增“新名字本地包在自己的 patch 里挂载管理服务时，pnpm 未被调用即拒绝”。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest ... tests/local-bundle.spec.ts`（plugin-manager） | 39 测试通过，exit 0 |
| `vitest ... tests/manager.spec.ts --testTimeout=30000` | 180 测试通过，exit 0 |
| `vitest ... operations/tools/package-reload` | 3 文件、134 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit`（plugin-manager） | exit 0 |
| `node --import tsx/esm .tmp/c1-c25-fingerprint-probe.mjs` | `sameFingerprint:false`，exit 0 |

验收曾记录的 manager 两个真实 Git/pnpm 5 秒超时在本次 30 秒配置下未复现；这不等于流程已修好，R10.3 仍需按真实原因处理，不能以加 timeout 代替结论。

## 仍未验证

- R2.1：`offline: proven` 仍只表示元数据校验通过，尚未把“清单一致 / 包内依赖文件存在 / 目标 pnpm store 就绪 / 模块可加载”拆成独立状态。
- R2.2：尚未提供带锁定记录与完整物料的离线交付，也没有空 store、无网络、仓库外 profile 的真实本地安装 fixture。
- R2.4：VS Code 本地导入路径的离线政策未实现；未证明完整的本地包仍可能走到默认公网 registry。
- R2.6：hostProvided/peer 的实际可满足性检查仍未补。
- R1、R3、R4、R8 未开始；真实 GUI、候选 VSIX、真实公司网关仍未验证；C9/C10 维持暂缓。
